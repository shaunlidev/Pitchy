# Pitchroom V6 Agent — Implementation and Harness Plan

Status: local implementation complete; external evidence gates remain
Scope: first production-shaped vertical slice only
Last updated: 2026-10-14
Authority: `../SOURCE_OF_TRUTH.md` and `../pitchroom-v6/{README,PRD,DESIGN,EVIDENCE,HARNESS}.md`

## 1. Outcome

Build one observable agent loop:

```text
text material
  -> deterministic ingestion and chunking
  -> agent reads through bounded tools
  -> agent proposes themes, claims, gaps, and one next question
  -> controller verifies provenance and policy
  -> user reviews, corrects, or preserves unknowns
  -> controller creates a new understanding version
  -> workflow stops at an explicit approval boundary
```

This slice is complete only when a reviewer can replay a run and answer:

1. What did the agent receive?
2. What tools did it call, in what order, with what results?
3. Which source text supports each factual claim?
4. What remained unknown or conflicting?
5. What did the user change?
6. Why did the state machine advance, stop, or fail?
7. Which deterministic tests, agent evals, and UI QA checks passed?

The implementation is an agent system, not a text-generation endpoint embedded in a page.

## 2. Frozen decisions

These are implementation inputs, not open product questions.

| ID | Decision | Consequence |
|---|---|---|
| D01 | Build one vertical slice before the broader product shell. | No Positioning or Deck generation in this plan. |
| D02 | Accept pasted text, `.txt`, and `.md` first. | PDF, OCR, URLs, and rich documents are deferred. |
| D03 | Use Vercel AI SDK for the model/tool loop. | The SDK does not own product state or approval policy. |
| D04 | Use a single TypeScript deployable with strict internal packages. | No microservices or distributed workflow engine. |
| D05 | Use PostgreSQL, Drizzle ORM, Drizzle Kit, and Zod. | Persistence is SQL-first and schemas are explicit. |
| D06 | Cite evidence as `sourceId + chunkId + exactQuote`. | The controller must verify exact quote containment. |
| D07 | Stop at `review_required`; never silently advance. | User review is part of the state machine. |
| D08 | User corrections are attributed user inputs. | Corrections never masquerade as source evidence. |
| D09 | Unknowns remain explicit. | The agent may not fill missing facts with plausible guesses. |
| D10 | Deterministic tests, model evals, browser QA, and user acceptance are separate gates. | Passing one gate cannot be reported as passing another. |

## 3. Non-goals

- Positioning generation, slide outlining, deck generation, or export.
- PDF/OCR/image ingestion.
- Multi-user collaboration, billing, organizations, or permissions administration.
- A general-purpose autonomous agent platform.
- Long-term memory outside the project database.
- Background autonomous work after a run reaches `review_required`.
- Production deployment, paid services, or real customer data.
- Visual parity for the entire V6 prototype.
- Proving customer demand or real-world AI quality from synthetic tests.

## 4. System boundaries

```text
┌──────────────────────────────── apps/web ────────────────────────────────┐
│ UI + HTTP/SSE adapters                                                   │
│ Material input | run view | evidence inspector | review/correction      │
└───────────────┬───────────────────────────────────────┬──────────────────┘
                │ commands                              │ events/read models
┌───────────────▼────────────── packages/domain ─────────▼─────────────────┐
│ state machine | schemas | invariants | approval policy | error taxonomy  │
└───────────────┬───────────────────────────────────────┬──────────────────┘
                │ ports                                 │ validated objects
┌───────────────▼────────────── packages/agent ──────────▼─────────────────┐
│ Vercel AI SDK runner | bounded tools | prompt policy | proposal adapter  │
└───────────────┬───────────────────────────────────────┬──────────────────┘
                │ repository ports                      │ tool reads/events
┌───────────────▼────────── packages/persistence ────────▼─────────────────┐
│ Drizzle schema | migrations | repositories | transaction boundaries     │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │
                              PostgreSQL

Cross-cutting:
packages/testkit -> fakes, fixtures, fake model, clocks, IDs
packages/evals   -> cases, runners, graders, reports
```

Dependency rule:

```text
web -> domain + agent + persistence
agent -> domain ports only
persistence -> domain types/ports only
evals -> agent + domain + testkit
testkit -> domain only
domain -> no workspace package
```

Forbidden dependencies:

- `domain` importing AI SDK, Next.js, Drizzle, or PostgreSQL.
- `agent` writing directly to tables.
- UI deciding legal state transitions.
- prompts encoding facts that should be enforced by code.
- eval code changing production behavior.

## 5. State, ownership, and trust

### 5.1 State machine

```text
empty
  └─ add valid material ─> materials_ready
       └─ start run ─────> reading
            ├─ validated proposal ─> structuring
            │    ├─ persist version + question ─> review_required
            │    └─ persistence failure ────────> failed
            ├─ tool/model/policy failure ───────> failed
            └─ budget/circuit breaker ──────────> failed

review_required
  ├─ submit correction/answer/keep-unknown ─> reading -> review_required
  └─ explicit accept ───────────────────────> accepted

failed
  └─ explicit retry with new run ID ────────> reading
```

No transition may be inferred from a model response. The controller validates and performs every transition.

### 5.2 Evidence classes

| State | Meaning | Required fields | Forbidden behavior |
|---|---|---|---|
| `supported` | Source material directly supports the claim. | One or more verified source refs. | Inventing or normalizing beyond the quote. |
| `conflicting` | Sources make incompatible assertions. | At least two verified refs and conflict explanation. | Choosing a winner without user policy. |
| `user_asserted` | A user supplied or corrected the claim. | One or more `userInputIds`. | Presenting it as source-derived. |
| `unknown` | Available evidence cannot establish the claim. | Clear missing-information statement. | Attaching fake evidence or guessing. |

### 5.3 Source trust rule

Uploaded/pasted material is untrusted data. Instructions inside material are never agent instructions. Tool descriptions, system prompts, and state policy outrank source text. Prompt-injection cases are required in evals.

### 5.4 Decision ownership

| Decision | Owner | Enforced by |
|---|---|---|
| What source text exists | User/system ingestion | Persistence + hashes |
| How text is chunked | Deterministic code | Chunker tests |
| Which text to inspect | Agent within budgets | Tool policy |
| Proposed understanding | Agent | Structured output schema |
| Whether evidence is valid | Controller | Quote/provenance validators |
| Whether a correction is true | User | Attribution, not source promotion |
| Whether to accept understanding | User | Explicit approval command |
| Whether workflow may advance | Controller | State machine |

## 6. Harness model

The harness has four independent layers:

```text
L1 deterministic contract tests
   schemas, state transitions, chunking, repositories, tool policy
                     ↓
L2 agent simulation tests
   fake model + real tools/controller + recorded event trace
                     ↓
L3 model evals
   fixed cases + live model + deterministic and rubric graders
                     ↓
L4 browser QA and human acceptance
   real UI flow + synthetic project + explicit visual/behavior review
```

Passing rule: `L1 && L2 && L3 && L4`. A skipped layer is reported as `NOT RUN`, never `PASS`.

### 6.1 Evidence artifact per run

Every simulated or live agent run produces a redacted local bundle:

```text
.artifacts/agent-runs/<run-id>/
  manifest.json        # code/config/model/prompt/case identifiers
  inputs.json          # fixture/source IDs and hashes, not secrets
  events.jsonl         # ordered state, tool, model, validation events
  proposal.json        # raw structured proposal
  outcome.json         # terminal state and typed failure if any
  scores.json          # grader results when evaluated
```

Raw browser recordings are not created by default and remain subject to the V6 evidence authorization and cap.
`.artifacts/` is local, gitignored, redacted by default, and outside the V6 recorded-evidence roots. The Phase 0 harness adds an explicit retention/size check; it does not delete artifacts automatically.

### 6.2 Standard commands to create

```bash
pnpm check              # currently available static checks + deterministic tests
pnpm test               # all deterministic unit/integration tests
pnpm test:watch         # local feedback loop
pnpm db:generate        # generate Drizzle migration from schema
pnpm db:migrate         # apply local migration
pnpm db:check           # migration drift and repository smoke test
pnpm harness:case -- <case-id>
pnpm harness:replay -- <run-id>
pnpm eval:offline       # deterministic graders, no external model call
pnpm eval:live          # authorized real-model run only
pnpm qa:e2e             # browser flow, after separate browser authorization
pnpm build              # production build
```

Commands that require credentials or network access must fail closed with an actionable message. They must never silently switch to a fake provider.

## 7. Phase plan

Each phase uses the same learning card:

```text
Purpose -> why this exists
Input -> what is treated as already decided
Your judgment -> what the user must inspect or decide
AI/engineering work -> what changes
Evidence -> what proves the change
Gate -> proceed / redo / stop
```

### Phase 0 — Establish the executable baseline

Purpose: make every later change observable through one stable command surface.

Input:

- Existing monorepo scaffold and contracts.
- Current passing typecheck, four deterministic tests, and production build.

Your judgment:

- Confirm that the first slice remains the only implementation target.
- Inspect the command names and evidence layout; these become the daily interface to the project.

AI/engineering work:

1. Add root scripts for `check`, tests, database, harness, evals, and build.
2. Add deterministic environment validation.
3. Add a shared typed error taxonomy.
4. Add stable clock and ID injection through `testkit`.
5. Add artifact writer with secret redaction and atomic writes.
6. Add CI-equivalent local command; do not configure hosted CI yet.

Tests:

- Missing environment variables fail with typed configuration errors.
- Fake clock and IDs produce byte-stable snapshots.
- Artifact writes are atomic and reject paths outside the artifact root.
- `pnpm check` returns nonzero on any failed sub-gate.

Evidence:

- Command transcript.
- One deterministic example run bundle.
- Existing build and tests remain green.

Gate:

- Proceed: a fresh checkout with installed dependencies can run `pnpm check` without services.
- Redo: command behavior depends on local hidden state.
- Stop: baseline requires a paid service, real model, or user secret.

### Phase 1 — Local PostgreSQL and repository boundary

Purpose: make workflow state durable, transactional, inspectable, and replayable.

Input:

- Existing Drizzle table definitions for projects, sources, chunks, runs, events, versions, inputs, and approvals.

Your judgment:

- Inspect table relationships and decide whether the stored event detail is understandable enough to debug a failed run.
- Confirm local Docker PostgreSQL as the development database; external hosted DB remains unapproved.

AI/engineering work:

1. Add a local Compose file with a fixed development database and health check.
2. Generate and review the initial SQL migration.
3. Define repository ports in `domain`; implement them in `persistence`.
4. Implement transaction boundaries:
   - ingest source + chunks atomically;
   - append agent event with monotonic sequence;
   - persist proposal + question + transition to `review_required` atomically;
   - persist user input + derived version atomically;
   - accept a specific current version atomically.
5. Add optimistic concurrency through project/version revision.
6. Add retry-safe idempotency keys for commands.

Tests:

- Migration applies to an empty DB and produces the expected schema.
- Repository contract suite runs against PostgreSQL.
- Duplicate idempotency keys do not duplicate sources, events, or approvals.
- Stale revision updates fail with `CONFLICT`.
- Transaction rollback leaves no partial version or transition.
- Event sequences remain strictly increasing per run.

Evidence:

- Reviewed SQL migration.
- Repository contract test report.
- Schema snapshot and one transaction rollback trace.

Gate:

- Proceed: database can be destroyed/recreated and all repository tests pass.
- Redo: domain tests require Drizzle or a live DB.
- Stop: a transition can commit without its evidence/version record.

### Phase 2 — Deterministic ingestion and chunking

Purpose: turn input material into stable, addressable evidence before involving a model.

Input:

- Pasted text, UTF-8 `.txt`, UTF-8 `.md`.
- File-size and project-size limits defined in configuration.

Your judgment:

- Review chunk boundaries on three representative materials: short, long, and badly formatted.
- Decide whether a quoted passage is understandable in the evidence inspector without excessive surrounding text.

AI/engineering work:

1. Normalize newlines and safe metadata; preserve original text bytes/hash.
2. Reject unsupported types, invalid encoding, empty text, and over-limit input.
3. Implement deterministic paragraph-aware chunking with an initial default of 6,000 characters and 600 characters overlap; pin the values in run metadata and adjust only from fixture/eval evidence.
4. Store source hash, ordinal, offsets, and exact chunk text.
5. Expose source inventory and chunk retrieval through domain ports.
6. Add deletion behavior only if required by the current UI flow; otherwise defer it explicitly.

Tests:

- Identical text/config produces identical chunks and IDs.
- Every original character is covered or its normalization is documented.
- Quote lookup handles repeated text without losing the cited chunk identity.
- Markdown syntax is data, not executable instructions.
- Empty, binary, oversized, and malformed UTF-8 inputs fail clearly.

Evidence:

- Golden chunk snapshots for at least six fixtures.
- Coverage report from original offsets to chunks.
- One rejected-input trace per error class.

Gate:

- Proceed: the same fixture produces byte-identical chunks across two runs.
- Redo: quote validation needs fuzzy matching to pass normal input.
- Stop: original source text cannot be reconstructed or inspected.

### Phase 3 — Tool contracts and bounded execution policy

Purpose: give the agent capabilities without giving it control over product state.

Input:

- Repository read ports and deterministic chunks.
- Existing proposal schema and source-reference validator.

Your judgment:

- Inspect tool inputs/outputs as if debugging a wrong answer.
- Confirm the budgets feel strict enough to prevent loops but large enough for representative material.

AI/engineering work:

Implement only these initial tools:

1. `list_sources(projectId)` — source IDs, names, types, sizes, hashes.
2. `list_chunks(sourceId, cursor)` — chunk metadata in bounded pages.
3. `read_chunk(chunkId)` — exact chunk text and offsets.
4. `search_chunks(projectId, query, limit)` — deterministic case-folded token/substring scoring with stable tie-breaking first; semantic/vector search is deferred.
5. `submit_understanding(proposal)` — proposes; does not persist or transition by itself.

Controller budgets:

- maximum model steps per run;
- maximum total tool calls;
- maximum repeated identical call count;
- maximum returned characters/tokens;
- wall-clock timeout;
- three consecutive tool failures circuit breaker;
- cancellation signal propagation.

Tests:

- Tool input/output schemas reject extra and malformed fields.
- Cross-project reads are impossible.
- Pagination is stable and bounded.
- Repeated calls trigger the circuit breaker.
- Cancellation produces a terminal failed/cancelled event.
- `submit_understanding` cannot mutate persistence directly.

Evidence:

- Tool contract catalogue.
- Deterministic trace for normal, repeated-call, timeout, and unauthorized-read cases.

Gate:

- Proceed: every tool call is replayable from stored inputs and fixture state.
- Redo: business policy exists only in the prompt.
- Stop: the agent can approve, transition, or directly write project state.

### Phase 4 — Fake-model end-to-end agent loop

Purpose: prove orchestration and failure behavior before spending model calls.

Input:

- Real controller, tools, validators, repositories, and database.
- Scripted fake model provider from `testkit`.

Your judgment:

- Read two complete event traces: one successful and one failed.
- Explain in your own words which part is agentic and which part is deterministic; if that is unclear, the trace is insufficient.

AI/engineering work:

1. Implement the Vercel AI SDK runner behind `UnderstandingAgentRunner`.
2. Add prompt/version identifiers, provider/model metadata, and run budgets.
3. Translate SDK events into stable domain events.
4. Validate structured proposal syntax and semantic invariants.
5. Verify every exact quote exists in the referenced chunk.
6. Persist only validated proposals.
7. Stop at `review_required` with one question.
8. Model malformed output, tool errors, max-step exhaustion, timeout, cancellation, and persistence failure.

Required simulated scenarios:

- happy path with supported claims;
- missing information remains unknown;
- conflicting sources remain conflicting;
- user-asserted data is not converted to source evidence;
- fabricated quote is rejected;
- nonexistent chunk is rejected;
- prompt injection in source material is ignored;
- model never submits and hits budget;
- model repeats a tool until circuit breaker;
- persistence fails after proposal validation;
- two concurrent runs target one project.

Evidence:

- Scenario test report.
- Full run bundles for all required scenarios.
- Replay command proves the same validation/state outcome without calling a model.

Gate:

- Proceed: orchestration is green with the fake model and all failure outcomes are typed.
- Redo: tests mock the controller or validators rather than only the model boundary.
- Stop: a malformed/fabricated proposal reaches `review_required`.

### Phase 5 — Review, correction, versioning, and approval

Purpose: make human control a real product boundary, not a chat convention.

Input:

- A validated understanding version in `review_required`.

Your judgment:

- Try to correct a claim, answer the question, preserve an unknown, and reject an interpretation.
- Decide whether the history makes it obvious what changed and who supplied it.

AI/engineering work:

1. Define commands for `submit_user_input`, `rerun_understanding`, and `accept_understanding`.
2. Record user input immutably with input type and target version.
3. Create new versions; never mutate the historical proposal.
4. Preserve source-backed, user-asserted, conflicting, and unknown distinctions.
5. Require acceptance of the current revision only.
6. Reject stale tabs and duplicate submissions safely.
7. Expose version diff and run-to-version linkage.
8. Keep downstream phases inaccessible even after acceptance in this slice.

Tests:

- Correction creates a new attributed version.
- Keeping unknown does not invent a value.
- Stale acceptance and stale correction return a clear conflict.
- Retry with the same idempotency key is safe.
- Version history is append-only.
- Approval references the exact accepted version and actor.

Evidence:

- Version-history fixture.
- State transition trace from input through acceptance.
- Concurrent/stale-client test results.

Gate:

- Proceed: a user can reconstruct every change from history.
- Redo: the latest document is correct but provenance was lost.
- Stop: approval can target a stale or unreviewed version.

### Phase 6 — HTTP API and event stream

Purpose: expose the application boundary without leaking runtime details into the UI.

Input:

- Domain commands, repository implementations, controller, and event model.

Your judgment:

- Inspect API errors and event names; decide if they explain recovery without reading server logs.

AI/engineering work:

1. Add route handlers for projects, sources, runs, versions, user inputs, approval, and run events.
2. Validate all request/response payloads with Zod.
3. Add SSE for ordered run events; support reconnect with last event ID.
4. Use command idempotency keys and optimistic concurrency tokens.
5. Map typed domain errors to stable HTTP error envelopes.
6. Add request IDs and structured redacted logs.
7. Ensure aborted client connections propagate cancellation when safe.

Tests:

- API contract tests against a real local database.
- SSE reconnect returns no missing or duplicated event sequence.
- Invalid input never reaches agent or persistence.
- Cross-project identifiers fail closed.
- Server logs do not contain complete source text or secrets by default.

Evidence:

- OpenAPI-like contract document generated from route schemas or maintained beside them.
- HTTP integration report and sample SSE transcript.

Gate:

- Proceed: a non-browser client can complete the entire slice.
- Redo: UI needs database/runtime-specific knowledge.
- Stop: retries can create duplicate runs or approvals.

### Phase 7 — Minimal Materials and Clarify UI

Purpose: let a human operate and inspect the loop end to end.

Input:

- V6 design authority for Materials and Clarify.
- Working API and synthetic fixture project.

Your judgment:

- Review information hierarchy, not decorative polish: material state, agent activity, evidence, unknowns, correction, and approval must be visible.
- Perform the primary task without developer tools.

AI/engineering work:

1. Material input for paste, `.txt`, and `.md`.
2. Source inventory with processing/error state.
3. Start/retry/cancel run controls with correct availability.
4. Live event progress summarized for users; detailed trace remains inspectable.
5. Understanding view for themes, claims, conflicts, gaps, and one next question.
6. Evidence inspector linking exact quote to source/chunk context.
7. Correction, answer, keep-unknown, and accept actions.
8. Version history and stale-state conflict recovery.
9. Explicit empty, loading, failure, cancelled, and review-required states.

Tests:

- Component tests for every state.
- Accessibility checks for labels, focus, keyboard flow, and status announcements.
- Client state tests for disconnect/reconnect and stale revision.
- No optimistic UI claims approval before the server commits it.

Evidence:

- Component state matrix.
- Browser E2E results when separately authorized.
- Human acceptance notes for the synthetic fixture.

Gate:

- Proceed: the user can cite the source of a claim and correct it without inspecting logs.
- Redo: agent activity is visible but its reasoning evidence is not.
- Stop: UI makes an unverified proposal look accepted or source-backed.

### Phase 8 — Offline eval harness and failure taxonomy

Purpose: turn “the agent seems good” into repeatable, inspectable measurements.

Input:

- Stable proposal schema, tools, trace format, and fake-model harness.

Your judgment:

- Review every case label and expected behavior.
- Mark which errors would break trust versus merely reduce usefulness.
- Approve thresholds before viewing aggregate live-model results to avoid moving the goalposts.

AI/engineering work:

1. Define versioned JSONL/YAML cases with source fixtures and expected properties.
2. Create 15–30 initial cases across:
   - straightforward supported facts;
   - missing information;
   - contradictory materials;
   - irrelevant/noisy materials;
   - repeated and ambiguous quotes;
   - user corrections;
   - preserved unknowns;
   - unsupported plausible claims;
   - source prompt injection;
   - long material requiring multiple reads;
   - tool failure and partial retrieval.
3. Implement deterministic graders:
   - schema validity;
   - evidence existence and quote containment;
   - no source refs on unknown/user-asserted claims;
   - conflict requires multiple sources;
   - exactly one next question;
   - budget and terminal-state compliance;
   - replay trace integrity.
4. Define human rubric scorecards that can run without a model. Model-assisted grading is a separate live-eval adapter and inherits the same external-call authorization gate:
   - groundedness;
   - relevant coverage;
   - question usefulness;
   - theme distinctness;
   - uncertainty honesty;
   - user-control preservation;
   - traceability.
5. Store per-case output and aggregate report with prompt/model/config versions.
6. Add regression comparison against an explicitly chosen baseline.

Initial thresholds:

| Metric | Threshold | Severity |
|---|---:|---|
| Schema validity | 100% | blocking |
| Invalid/nonexistent evidence accepted | 0 cases | blocking |
| Unknown converted to fact without evidence | 0 cases | blocking |
| Prompt injection changes policy | 0 cases | blocking |
| Run terminates within budgets | 100% | blocking |
| Groundedness rubric | >= 0.90 mean and no critical case < 0.75 | blocking |
| Question usefulness | >= 0.80 mean | diagnostic initially |
| Relevant coverage | >= 0.80 mean | diagnostic initially |
| Traceability | >= 0.95 mean | blocking |

Thresholds are hypotheses until a first reviewed baseline. Changes require a recorded rationale; they cannot be weakened merely to make a run green.

Evidence:

- Versioned case set and failure taxonomy.
- Offline deterministic report.
- Empty live-eval slot explicitly marked `NOT RUN` until authorized.

Gate:

- Proceed: all deterministic graders catch intentionally seeded violations.
- Redo: graders reward verbosity or exact wording instead of required behavior.
- Stop: aggregate scores can hide a trust-breaking case.

### Phase 9 — Authorized real-model integration

Purpose: test the one genuinely nondeterministic capability after the system around it is trustworthy.

Input:

- Explicit authorization for provider use, credentials, cost, and external data transfer.
- Synthetic/non-private eval fixtures.
- Approved thresholds.

Your judgment:

- Approve provider/model and maximum run budget.
- Review the first five case outputs individually before considering aggregate scores.
- Classify each failure: prompt, tool design, context selection, model capability, grader, or product contract.

AI/engineering work:

1. Add provider adapter and env validation without embedding secrets.
2. Pin model identifier and inference settings.
3. Add usage, latency, retry, and estimated-cost capture.
4. Run a five-case smoke set, then the full set only if no blocking failure occurs.
5. Compare against baseline; never overwrite prior results.
6. Convert failures into new permanent regression cases before repair.

Evidence:

- Model/config manifest.
- Per-case outputs and scores.
- Cost/latency summary.
- Failure triage ledger.

Gate:

- Proceed: blocking thresholds pass and reviewed failures are non-critical.
- Redo: failures have a plausible repair and a regression case.
- Stop: source data policy is unclear, a trust-breaking case occurs, or budget is exceeded.

### Phase 10 — Browser QA and human acceptance

Purpose: validate that the built system can actually be operated, not only called through tests.

Input:

- Explicit authorization for browser tooling/recording.
- Isolated synthetic project state.
- Stable build and passing lower harness layers.

Your judgment:

- Personally perform the critical path.
- Judge whether evidence, unknowns, correction, and approval boundaries are legible.
- Record confusion separately from functional defects.

QA journeys:

1. Paste a supported source, run agent, inspect citation, accept.
2. Upload `.md`, observe conflicting sources, preserve conflict.
3. Receive an unknown, keep it unknown, and create a new version.
4. Correct a claim; confirm user attribution and history.
5. Trigger malformed input and recover.
6. Disconnect/reconnect during a run.
7. Open two tabs; attempt stale correction and stale approval.
8. Trigger agent timeout and retry as a new run.
9. Navigate entirely by keyboard and inspect status announcements.

Evidence:

- QA matrix with pass/fail/not-run.
- Defect reports with reproduction, expected, actual, severity, and artifact links.
- Representative screenshots only when authorized and within evidence limits.
- User acceptance record distinct from automated results.

Gate:

- Proceed: all critical journeys pass and the user accepts the interaction boundary.
- Redo: a reproducible functional or comprehension defect remains repairable.
- Stop: evidence/approval semantics are misleading or inaccessible.

### Phase 11 — Operational hardening and deployment readiness

Purpose: make a truthful decision about whether the slice is ready to leave local development.

Input:

- Passing lower layers and resolved critical defects.

Your judgment:

- Choose whether to deploy; this plan does not authorize deployment.
- Review the data retention, deletion, provider transfer, and cost policies before any real users.

AI/engineering work:

1. Define health/readiness checks and graceful shutdown.
2. Define migration forward/rollback procedure and backup expectations.
3. Add rate limits, request-size limits, run budgets, and abuse controls.
4. Add structured metrics for run outcome, step count, tool failures, latency, and cost.
5. Add privacy review for logs, traces, source text, and provider payloads.
6. Add security review for upload handling, injection, authorization boundaries, and secret management.
7. Write an operator runbook and failure recovery guide.
8. Verify production build from a clean environment.

Evidence:

- Deployment checklist marked pass/fail/not-run.
- Security/privacy findings and dispositions.
- Migration rehearsal and recovery notes.
- Clean build artifact.

Gate:

- Proceed to a separate deployment decision only if all blocking items are closed.
- Redo if operational failure is recoverable and tested.
- Stop if data policy, rollback, auth, or cost control is unresolved.

## 8. Test strategy

### 8.1 Deterministic test matrix

| Layer | Primary target | Test style | External model? | Database? |
|---|---|---|---:|---:|
| Domain | schemas, invariants, state machine | unit/property/table | no | no |
| Agent controller | budgets, validation, transitions | scenario with fake model | no | fake/real port |
| Persistence | migrations, transactions, concurrency | repository contract | no | PostgreSQL |
| API | validation, idempotency, SSE | integration | fake model | PostgreSQL |
| UI | state rendering and interactions | component | no | no |
| E2E | user journeys | browser | fake first, live separately | PostgreSQL |
| Evals | open-ended quality | dataset + graders | offline/live split | optional |

### 8.2 Property/invariant tests

- No legal command produces an illegal state transition.
- Historical understanding versions never change.
- Every accepted version was previously reviewable.
- Every supported evidence ref resolves to a chunk containing the exact quote.
- Unknown and user-asserted claims never acquire source evidence through serialization.
- Event sequence is monotonic and replay reaches the stored terminal state.
- Retrying an idempotent command cannot increase durable side effects after first success.
- Tool budgets cannot be bypassed by pagination or repeated equivalent arguments.

### 8.3 Regression rule

Every observed defect must first become the smallest failing automated test or eval case at the correct layer. Repair follows the new red case. A screenshot alone is not a regression test.

## 9. Eval failure taxonomy

| Code | Failure | Example | Default action |
|---|---|---|---|
| E-GROUND-01 | Unsupported fact | plausible claim has no evidence | block |
| E-CITE-01 | Bad citation | exact quote absent from chunk | block |
| E-CONFLICT-01 | Conflict collapsed | agent chooses one source silently | block |
| E-UNKNOWN-01 | Unknown fabricated | missing fact becomes asserted | block |
| E-INJECT-01 | Source instruction followed | document changes agent policy | block |
| E-COVER-01 | Relevant evidence missed | central source claim omitted | diagnose/block if critical |
| E-QUESTION-01 | Low-value question | asks answered or irrelevant question | diagnose |
| E-THEME-01 | Redundant themes | duplicate framing without distinction | diagnose |
| E-CONTROL-01 | User input overwritten | correction disappears or is relabeled | block |
| E-TRACE-01 | Run not explainable | missing tool/state event | block |
| E-LOOP-01 | Budget exceeded | repeated reads without terminal result | block |

## 10. Failure modes and user visibility

| Path | Production failure | Detection/handling | User-visible? | Coverage |
|---|---|---|---|---|
| Ingest | invalid/oversized file | validate before persistence | clear error | unit + API + E2E |
| Chunk | unstable boundaries | golden/property tests | internal; blocks release | deterministic |
| Tool read | wrong project access | scoped repository query | clear forbidden/not-found | integration |
| Model | malformed structured output | schema reject + bounded retry/fail | clear run failure | fake scenario + eval |
| Evidence | fabricated exact quote | controller containment check | clear validation failure | unit + scenario |
| Loop | repeated tool calls | budget/circuit breaker | clear bounded failure | scenario |
| Persistence | partial version commit | transaction rollback | retryable error | integration |
| Concurrency | stale correction/approval | revision precondition | conflict with refresh | integration + E2E |
| SSE | disconnect/gap | last-event replay | reconnect state | API + E2E |
| Provider | timeout/rate limit | typed retry policy then fail | actionable failure | adapter + live smoke |
| Eval | grader crash | case marked error, run non-green | report shows error | harness test |
| Logging | secret/source leakage | redaction + tests | internal; blocks release | deterministic/security |

Critical gap rule: any silent failure with neither test nor error handling blocks implementation completion.

## 11. Security and privacy checklist

- Treat all material as hostile data.
- Never execute or follow instructions found in material.
- Verify project ownership/scope on every repository query and API command.
- Validate filename, type, size, encoding, and content length.
- Do not log API keys, auth headers, full prompt payloads, or full source text by default.
- Redact run artifacts; keep synthetic fixtures separate from user material.
- Use parameterized Drizzle queries and reviewed migrations.
- Propagate cancellation and cap steps, calls, bytes, time, retries, and cost.
- Require explicit authorization before external model transfer.
- Document retention/deletion before real user data.
- Ensure approval endpoints require the current version and an authenticated actor before deployment.

The local slice may use a synthetic fixed actor. This is not an authentication system; production deployment is blocked until authentication and authorization are designed and tested.

## 12. Observability contract

Every run records:

- run ID, project ID, triggering command ID;
- code version, schema version, prompt version;
- provider/model/config when applicable;
- start/end timestamps and terminal outcome;
- ordered state-transition events;
- tool call name, validated arguments hash, result metadata, duration, and error class;
- proposal validation results;
- budget counters;
- linked understanding version;
- user input and approval IDs without merging their trust classes;
- token/latency/cost data when supplied by the provider.

Metrics are diagnostics, not acceptance by themselves. A completed run is not necessarily a correct run.

## 13. Performance budgets

Initial local/synthetic budgets; revise only from measured evidence:

| Budget | Initial target |
|---|---:|
| Single source size | <= 1 MiB |
| Total source text per project | <= 5 MiB |
| Chunk size | configuration pinned and snapshot-tested |
| Tool calls per run | <= 20 |
| Model steps per run | <= 8 |
| Consecutive tool failures | <= 3 |
| Agent wall time | <= 120 s live; much lower in fake tests |
| API non-agent p95 locally | <= 300 ms on fixture data |
| SSE event gap after commit | <= 1 s locally |

These are protection rails, not promised production SLOs.

## 14. Task dependency graph

```text
T00 baseline harness
 ├─> T10 database/migrations ─> T11 repositories ───────────────┐
 ├─> T20 ingestion/chunking ─> T30 read/search tools ──────────┤
 └─> T01 trace/artifact format ─> T40 fake-model agent loop ───┤
                                                               ├─> T50 review/versioning
                                                               ├─> T60 HTTP/SSE
                                                               ├─> T70 UI
                                                               ├─> T80 offline evals
                                                               └─> T90 authorized live eval
T50 + T60 + T70 + T80 ─> T100 browser QA ─> T110 hardening
```

### Dependency table

| Step | Modules touched | Depends on |
|---|---|---|
| T00 command surface | workspace config, testkit | — |
| T01 trace/artifact contract | domain, testkit | T00 |
| T10 schema/migration | persistence | T00 |
| T11 repository ports/impl | domain, persistence | T10 |
| T20 ingestion/chunking | domain, persistence | T00, T11 |
| T30 agent tools | domain, agent | T11, T20 |
| T40 fake-model loop | agent, testkit, persistence | T01, T30 |
| T50 human review/versioning | domain, persistence, agent | T40 |
| T60 HTTP/SSE | web, domain, persistence, agent | T40, T50 |
| T70 UI | web | T60 |
| T80 offline eval harness | evals, testkit, agent | T40 |
| T90 live model eval | agent, evals | T80 + explicit authorization |
| T100 browser QA | web, testkit | T70, T80 + explicit authorization |
| T110 hardening | all operational boundaries | T90, T100 |

Parallelization policy:

- Before T40, keep domain contracts sequential; they are the shared language of every lane.
- After T40, Lane A (`T50 -> T60 -> T70`) and Lane B (`T80`) may proceed in parallel if they do not edit shared domain contracts independently.
- T90 and T100 wait for their explicit authorizations and prerequisites.
- Any shared change to proposal schema, event schema, or state machine returns to sequential integration first.
- Do not create worktrees merely for speed during the learning pass; use them only when independent lanes are actually delegated.

## 15. Build-actionable checklist

| ID | Task | Proof of completion |
|---|---|---|
| T00.1 | Add root harness scripts and environment check | `pnpm check` is service-free and green |
| T00.2 | Add fake clock/ID factories and typed errors | deterministic snapshot tests |
| T01.1 | Define stable event and artifact schemas | schema tests + example bundle |
| T01.2 | Implement redacted atomic artifact writer | path/redaction/atomicity tests |
| T10.1 | Add local PostgreSQL Compose service | health check passes |
| T10.2 | Generate and review initial migration | clean DB migration passes |
| T11.1 | Define repository ports | domain remains dependency-clean |
| T11.2 | Implement transactional repositories | contract suite passes |
| T11.3 | Add idempotency and optimistic concurrency | duplicate/stale tests pass |
| T20.1 | Implement input validation and hashing | rejection and stable-hash tests |
| T20.2 | Implement stable paragraph chunker | golden/property tests pass |
| T30.1 | Implement four bounded read/search tools | tool contract tests pass |
| T30.2 | Implement submit-proposal boundary and budgets | mutation/budget tests pass |
| T40.1 | Add AI SDK runner and fake provider | fake happy path passes |
| T40.2 | Add event translation and proposal validation | required scenario suite passes |
| T40.3 | Add replay command | stored run reproduces outcome |
| T50.1 | Add immutable user input/version flow | version history tests pass |
| T50.2 | Add current-version approval | stale/duplicate tests pass |
| T60.1 | Add validated HTTP commands/queries | API contract tests pass |
| T60.2 | Add resumable SSE | gap/duplicate reconnect tests pass |
| T70.1 | Build Materials states and ingestion UI | component matrix passes |
| T70.2 | Build Clarify/evidence/review UI | component + accessibility tests pass |
| T70.3 | Add history/conflict recovery UI | stale-state test passes |
| T80.1 | Create case format and 15–30 cases | case review complete |
| T80.2 | Implement deterministic graders | seeded violations all caught |
| T80.3 | Implement rubric/report pipeline | versioned report generated |
| T90.1 | Add authorized real provider adapter | five-case smoke reviewed |
| T90.2 | Run full live eval | thresholds and triage recorded |
| T100.1 | Add authorized browser harness | critical journeys executable |
| T100.2 | Run QA and user acceptance | matrix + acceptance record |
| T110.1 | Complete security/privacy review | PASS locally: 97-file standard scan completed; both medium state-integrity findings remediated and regression-tested |
| T110.2 | Rehearse migration/recovery and clean build | readiness checklist complete |

## 16. Change protocol during implementation

For every task:

1. State the task ID and purpose.
2. Show the frozen inputs and the one decision, if any, that belongs to the user.
3. Write or select the failing test/eval first when behavior is testable.
4. Make the smallest implementation change.
5. Run the narrow check.
6. Run the affected package checks.
7. Run `pnpm check` at the phase gate, not after every trivial edit.
8. Present evidence as `PASS`, `FAIL`, or `NOT RUN`.
9. Ask the user to choose proceed/redo/stop only when judgment is genuinely required.
10. Record new failures in the taxonomy and add a regression case before repair.

The implementation log for a step should use:

```markdown
### Txx.y — title
- Purpose:
- Frozen inputs:
- User judgment:
- Implementation:
- Deterministic tests:
- Agent evals:
- Browser QA:
- Evidence:
- Result: PASS | FAIL | NOT RUN
- Gate: proceed | redo | stop
```

## 17. Authorization gates

The following do not inherit authorization from this implementation plan:

- real AI/model calls;
- sending any material to an external provider;
- paid or hosted database/service creation;
- new browser downloads or recorded browser evidence;
- deployment or production configuration;
- commits, pushes, pull requests, merges, or releases;
- destructive cleanup of existing workspace files or evidence.

When a phase reaches one of these boundaries, stop with the exact action, data, cost/risk, and evidence expected from authorizing it.

## 18. Definition of done for the first slice

All conditions must be true:

- The user can add supported text material and inspect its stable chunks.
- A bounded agent run can read tools and propose a valid understanding.
- Every supported claim has verified exact-quote provenance.
- Conflicts and unknowns remain explicit.
- User corrections remain attributed to user inputs.
- The system stops at `review_required` until an explicit user action.
- Acceptance targets only the current reviewed version.
- Runs, tool calls, validations, transitions, and failures are replayable.
- Deterministic unit/integration/contract suites pass.
- Required fake-model scenarios pass.
- The versioned eval set exists; offline graders pass; live eval is either passed or truthfully `NOT RUN`.
- Browser QA and human acceptance are either passed or truthfully `NOT RUN`.
- No critical security, privacy, concurrency, or silent-failure gap remains.
- Production build passes.
- No claim is made that the broader Pitchroom product is complete or shipped.

## 19. Immediate execution sequence

Start with these bounded steps:

1. `T00.1` — command surface and environment validation.
2. `T00.2` — deterministic clocks, IDs, and errors.
3. `T01.1` — event/trace schema.
4. `T10.1` — local PostgreSQL service.
5. `T10.2` — initial migration.
6. `T11.1–T11.3` — repository contracts and concurrency.
7. Stop for the Phase 1 review gate before implementing ingestion.

The first user learning checkpoint is not “the database works.” It is: can we replay a command and prove that state, evidence, and failure are consistent across the domain, event log, and database?

## 20. Decision ledger

| ID | Decision | Source | State |
|---|---|---|---|
| D01–D02 | Vertical slice; text-only first | User answers A | approved |
| D03 | Vercel AI SDK | User selected after framework comparison | approved |
| D04 | Single TypeScript deployable with internal packages | User answer A | approved |
| D05 | Drizzle + PostgreSQL | User accepted recommendation | approved |
| D06 | Exact quote provenance | User answer A | approved |
| D07–D10 | Explicit review boundary and separate evidence gates | User's AI-native process constraints | approved |

Approval readiness: PASS for planning the listed implementation. Authorization gates in section 17 remain intentionally separate.

## 21. Completion summary

- Scope: first material-to-reviewed-understanding agent loop.
- Architecture: deterministic domain/controller around a bounded Vercel AI SDK tool loop.
- Persistence: PostgreSQL + Drizzle with transactional event/version history.
- Verification: four distinct layers—contract tests, fake-agent scenarios, model evals, browser/human QA.
- Main trust boundaries: exact-quote provenance, explicit unknown/conflict states, attributed user corrections, current-version approval.
- Execution result: T00–T80 and the locally executable parts of T110 are implemented. The deterministic suite, PostgreSQL contracts, persistent restart flow, offline eval set, artifact replay, and production build pass; current evidence is maintained in `HARNESS_STATUS.md`.
- Live-provider result: the Vercel AI SDK adapter is implemented with pinned configuration, bounded steps, total/step/tool timeouts, structured output, source tools, and deterministic post-validation. Real calls, external transfer, and API cost were authorized on 2026-10-14, but no request has run because the key and pinned model are absent.
- QA result: HTTP journeys pass in fixture and persistent modes. Manual browser QA and five isolated Playwright journeys cover material/run/review/answer/correction/keep-unknown/accept/reset, upload conflict, invalid-file recovery, stale writes, SSE reconnect, accessible DOM structure, console, and keyboard order. One repeated-submission defect was repaired and reverified. Production screenshots at desktop, tablet, and mobile widths pass visual inspection; screen-reader output, live-model failure behavior, and human acceptance are not inferred.
- Deployment result: build and migration rehearsal pass, but authentication, provider privacy, backup destination, hosting, rollback, and production security decisions remain deployment blockers.
- Authorization status: real model calls/data transfer, API cost, browser recording/screenshots, deployment, and local commits were authorized on 2026-10-14. PR/publication was not authorized. Production identity/privacy/backup/hosting choices and credentials remain prerequisites, not generic permission requests.

### Implementation reconciliation

| Task range | Status | Evidence boundary |
|---|---|---|
| T00–T01 | PASS | command surface, deterministic utilities, typed errors, event/artifact schemas, redaction and replay tests |
| T10–T11 | PASS | local PostgreSQL 17, clean and upgrade migrations, transactional repository and concurrency tests |
| T20–T30 | PASS | stable ingestion/chunking, project-scoped tools, schema/provenance validation, step/tool/repeat/wall-clock budgets |
| T40–T60 | PASS | deterministic runner, persisted agent lifecycle, immutable versions/current approval, validated HTTP actions and resumable SSE |
| T70 | FUNCTIONAL + RESPONSIVE VISUAL PASS | Materials/Clarify/review/history UI is built; React state/interaction tests, manual browser QA, 5 Playwright journeys, keyboard order, accessible DOM structure, console, warmed performance, and production screenshots at 1280×720, 768×1024, and 375×812 pass |
| T80 | PASS | 15 versioned cases, deterministic grader, human rubric thresholds, redacted artifacts, replay command |
| T90 | ADAPTER IMPLEMENTED; LIVE EVAL NOT RUN | calls are authorized; `OPENAI_API_KEY` and pinned `OPENAI_MODEL` are required |
| T100 | PARTIAL PASS | manual QA, 5 repeatable Playwright journeys, and three-width production visual QA pass; one medium defect was repaired with interaction regressions; screen-reader, live-model disconnect/timeout, and human acceptance remain open |
| T110 | PARTIAL | build, migration recovery, runbook, health checks, security boundary, standard source audit, and two finding remediations exist; production auth/privacy/backup/hosting decisions remain open |

## 22. Engineering review notes

The plan was checked against architecture, code-quality, test, performance, and failure-mode concerns.

- Architecture: kept one deployable and one deterministic state owner; no workflow engine or vector database was added.
- Code quality: package dependency direction and repository ports prevent AI SDK/Drizzle details from entering the domain.
- Tests: fake-model end-to-end scenarios precede real-model evals; seeded violations must prove graders work.
- Performance: initial hard budgets are protective defaults and are versioned in run metadata.
- Resolved during review: artifact location/retention was made explicit; chunk/search behavior received deterministic defaults; human versus model-assisted grading was separated; local synthetic actor was distinguished from production authentication.
- Suppressed as premature: vector retrieval, distributed workers, multi-agent orchestration, and hosted observability.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | not run | Product scope is frozen for this implementation pass | 0 | NOT RUN | Not required for the requested implementation-only plan |
| Outside Review | unavailable | Independent second opinion | 0 | UNAVAILABLE | Required review-specific native task interface is unavailable in this host |
| Eng Review | `/plan-eng-review` | Architecture & tests | 1 | CLEAR | 4 plan gaps found and resolved in section 22 |
| Design Review | local implementation review | UI/UX gaps | 1 | PARTIAL | Functional browser, accessible-DOM, keyboard, and three-width responsive visual checks pass; screen-reader output and human acceptance remain NOT RUN |
| DX Review | local harness review | Developer experience gaps | 1 | CLEAR | One-command checks, case generation/replay, runbook, and environment gates are implemented |

**OUTSIDE COVERAGE:** Claude Code review was not run; compatible bounded native fallback interfaces were unavailable. No independent-review credit claimed.

**VERDICT:** LOCALLY IMPLEMENTED AND HARNESS-GREEN within the authorized slice; browser capture is complete, while live AI, human acceptance, and deployment retain separate evidence/readiness gates. Repository publication retains a separate authorization gate.

NO UNRESOLVED LOCAL-SLICE IMPLEMENTATION DECISIONS
