# Pitchroom application

> **2026-10-25 repaired continuation:** `62b81e2` / `story-v5-body-budget` passed one real DeepSeek Chinese-feedback revision in 21.07s. Generated body lengths were 24/34/41/35/43 words; the exact Chinese quotation, core message, proposed-versus-agreed criteria and saved unknowns were preserved. Explicit synthetic Apply, exact Deck V2 transfer and persistent HTTP readback passed. This proves the bounded saved-state continuation, not first-attempt reliability, browser QA or target-user acceptance. Earlier failures remain retained. See the [latest local report](.artifacts/english-pit17-revision-v5-20261025-01/acceptance-report.json).

> **2026-10-25 authorized follow-up:** Story generation with the local-reference contract succeeded in 18.27s. Its explicit synthetic adoption, exact Story-to-Deck transfer and nine HTTP continuation checks passed. The one authorized Chinese-feedback revision returned in 22.62s but was rejected: its last body contained 47 words against the 45-word limit. The adopted Story was preserved. Offline `story-v5-body-budget` now advertises that limit in the model response schema and preserves exact saved human wording; 433 Vitest cases, 4 Node guards, types and build passed. No further model request was made. Full-loop acceptance remains open. See the [follow-up report](.artifacts/english-pit17-story-retry-20261025-01/acceptance-report.json); earlier failures below remain historical evidence.

> **2026-10-25 bounded English continuation:** actual HTTP Positioning succeeded in 50.5 seconds, but the subsequent real Story output was rejected for an invalid local evidence reference. The prior Understanding, sources and adopted state were preserved. Two of three authorized model requests were used; Chinese Story revision and Deck continuation were not run. This is not an English full-loop PASS. See the [local attempt report](.artifacts/english-pit17-resume-20261025-01/acceptance-report.json).

> **Offline follow-up:** Story prompt `story-v4-local-references` supplies a separate local reference vocabulary and constrains the model response schema to it, while preserving saved local IDs. The domain validator still rejects references to undefined bases; no automatic ID repair or adoption was added. `pnpm check` passed with 432 Vitest cases, 4 Node guard checks, types and build. No further provider call was made; live Story and full-loop acceptance remain open.

> **2026-10-25 first-loop verification:**受众修订、自由故事判断、真实变化预览、明确采用与 Deck 追溯已在隔离合成项目中用真实 DeepSeek 跑通。已验证原样承接、Keep、Undo、人工编辑/旧稿、过期提示和重启恢复。此结论属于修复后的首批闭环验收，不代表首次生成可靠性、客户验收或上线就绪。原验收标准保持不变。详见 [本轮证据与限制](.artifacts/first-loop-20261025/acceptance-report.json)。Next.js 现已升级至公告修复版 16.4.1，并完成隔离构建和 HTTP 验证；原有服务/部署进程尚未由此验证重启。


> **2026-10-25 current verification:** a fresh `pitchroom-app/` implementation exists. The live web journey has now exercised real DeepSeek Understanding → worker Clarify → Positioning → Deck on an isolated synthetic PostgreSQL project. This supersedes older “not built / live not run” status statements for that narrow scope. Product acceptance remains **not passed**. See [full test matrix, DoD, actual failures and correction plan](docs/verification/2026-10-25-live-full-flow.md).


Fresh implementation derived from the `../pitchroom-v6/` product and design baseline.
The archived application is not an implementation dependency.

## Output language

Pitchroom uses English for its interface and newly generated Understanding, Clarify, Positioning, Story and Deck prose. Source or feedback language does not select the output language. Exact quotations, original framing, proper names and exact human edits retain their original wording. Existing saved versions remain unchanged; review and explicit adoption still govern new proposals. There is no language selector or per-project language migration. Offline regressions verify request policy and compiled text; real-model English quality still requires separate acceptance.

## Current local loop

The persistent loop is `Materials -> Clarify -> Positioning -> Deck` for one local project. It accepts pasted text, `.txt`, and `.md` sources. Understanding stops for review and acceptance. An accepted Understanding can receive a new background proposal without replacing the saved version. Apply creates a new review version, which requires acceptance again.

Positioning retains the two-lens Core Message comparison and original framing. The new Story workflow develops the chosen direction, accepts a free-text consultant judgment, and saves a locally computed before/after preview. Apply adopts the exact candidate. Keep, explicit Retry, Undo, saved-version restoration, source access, and exact manual wording remain separate actions.

Fresh Story decks use V2. Each page copies one adopted Story block's title, body, emphasis, and order. Deck creation makes no additional model call. Page trace opens the saved Story, Understanding, evidence, consultant input, rationale, and unresolved questions. Manual page edits create a new draft and retain derivation history without claiming that prior evidence validates the new words. Upstream changes preserve old drafts and mark them stale. Historical fixed five-page V1 drafts remain readable.

The labelled synthetic fixture supports offline checks. In fixture mode, choose **Develop working story** to enter the Story workflow. Persistent modes open that workflow after direction generation. The `live` runtime requires configured provider credentials, a model, and `PITCHROOM_LIVE_TRANSFER_ACK=authorized`. DeepSeek calls and material transfer require explicit user authorization. Model proposals still need review for meaning and claim scope.

Browser Print remains available. PDF fidelity and native assistive-technology validation are outside the current acceptance scope.

## File imports

Both file pickers accept multiple UTF-8 TXT/MD files. Each file saves independently; a failed item leaves successful sources intact and can be retried separately. An unconfirmed save retries the same operation identity. Uploading files preserves an unsaved written brief. Selected files and retry controls live in the current tab; reload keeps saved sources but requires reselecting failed files.

## Runtime validation

The HTTP workspace, health and SSE boundaries accept only `fixture`, `postgres-fake` and `live`. Unknown or empty `PITCHROOM_RUNTIME` values return 503 before accessing project storage or starting work. Omitting the value retains the local fixture default; production deployment policy and credentials remain separate release gates.

## Working-position recovery

PIT-19 browser checkpoint (2026-10-26): mixed TXT/MD imports, unsupported/invalid UTF-8 items, transient read/server failures, saved-but-lost responses and per-file retry passed in existing Chrome against an isolated PostgreSQL QA database. The browser file input was populated directly; no native chooser, download, model call or recording. Existing material and the unsent written brief survived; a reload read the persisted inventory correctly.

The run found and fixed a real remove/re-import defect: a new explicit command now restores a soft-deleted source and its original chunks. Replaying an old save command after removal instead returns a conflict; it cannot silently undo the removal. All four PostgreSQL suites passed (25 cases), alongside 446 Vitest cases, 4 Node guards, types and build. Earlier failed attempts remain local. See the [PIT-19 report](.artifacts/pit19-browser-20261026-01/acceptance-report.json). Retry file handles remain tab-local; cross-reload file retry and human acceptance are separate claims.

The same browser restores each project's destination, inspected Clarify topic and saved Deck/page selection after reload. Removed versions and inaccessible destinations fall back safely. Navigation does not accept, apply or generate work.

Under the approved seven-day recovery rule, unsubmitted brief text, answers/corrections, Story judgments/exact edits and Deck page edits are also stored locally in this browser. Drafts are scoped to their project and input context, including saved versions and source hashes. A matching single draft restores into the editor; earlier-version drafts are offered for explicit recovery. Conflicting tabs retain separate copies and offer a choice instead of overwriting active text. Successful submission clears only the submitted snapshot, preserving later typing and other drafts. Storage failures retain tab input and show a copy-before-close notice.

Opening a draft does not extend its seven-day expiry. Expired text is ignored and removed when this site next opens or its active cleanup runs; a closed browser cannot run cleanup. Draft recovery never submits or calls a model. Navigation identifiers remain in their separate browser record. This is browser-local recovery, not cross-device storage.

PIT-7 verification: 446 Vitest cases, 4 Node guards, types and build passed. Isolated Chrome checks covered refresh, tab/browser reopening, conflict choice, older-version recovery, successful draft cleanup, Story/Deck edits and service restart against the unchanged synthetic PostgreSQL project. No real-model request, recording or deployment. Human acceptance remains separate. See the [local report](.artifacts/pit7-drafts-20261025-01/acceptance-report.json).

For isolated synthetic browser checks alongside an existing dev server, use `PITCHROOM_RUNTIME=fixture PITCHROOM_ISOLATED_QA=1 pnpm --filter @pitchroom/web exec next dev -H 127.0.0.1 -p 43875`. The QA build lives in `.next-qa`; it does not share the ordinary dev build lock. Do not use an existing private project as a QA target.

## Workspace boundaries

- `apps/web`: browser UI and server routes.
- `packages/domain`: authoritative product contracts and deterministic state rules.
- `packages/agent`: agent runner boundary and application controller.
- `packages/persistence`: PostgreSQL/Drizzle schema and repositories.
- `packages/evals`: versioned evaluation cases and graders.
- `packages/testkit`: fake runners and deterministic fixtures.

## Run locally

```sh
pnpm install
docker compose up -d postgres
DATABASE_URL=postgres://pitchroom:pitchroom@127.0.0.1:54329/pitchroom pnpm db:migrate
pnpm dev
```

Open `http://127.0.0.1:3000`. The synthetic flow supports material ingestion,
bounded observable runs, exact-quote evidence, user correction with attribution,
question answers, immutable versions, stale-revision rejection, explicit
accept/apply/create boundaries, Deck editing/history, and stale Deck warnings.
Sources expand to stable chunk IDs, offsets, and text.

To run the same deterministic agent through PostgreSQL-backed state:

```sh
PITCHROOM_RUNTIME=postgres-fake \
DATABASE_URL=postgres://pitchroom:pitchroom@127.0.0.1:54329/pitchroom \
pnpm --filter @pitchroom/web exec next dev -H 127.0.0.1 -p 3001
```

`pnpm qa:persistent-http` verifies the complete persistent HTTP flow on port
3001. After restarting the server, `pnpm qa:persistent-readback` verifies that
the accepted state and version history survived the process.

`pnpm env:check` reads the same `apps/web/.env.local` used by Next.js (while
preserving any shell-provided overrides) and reports only readiness booleans;
it does not print credentials.

## Verification

```sh
pnpm check
DATABASE_URL=... pnpm test:server
pnpm eval:offline
pnpm qa:e2e
pnpm harness:case -- supported-growth
pnpm harness:replay -- eval-supported-growth
```

- `pnpm check`: type checks all packages, runs deterministic tests, and builds
  the production Next.js application. The check also runs four database-target guard checks through `pnpm test:server:guard`; these do not connect to a database.
- `DATABASE_URL=... pnpm test:server`: requires the dedicated `clarify_qa` user/database on localhost port `55437`, with no connection query/fragment overrides. It never loads `.env.local` or defaults to the daily development database. It discovers every persistence integration suite and runs files serially so migration hooks cannot race. It migrates the selected QA schema without truncating existing projects, and verifies
  project isolation, idempotency, transactional version creation, stale-write
  rejection, user-input attribution, positioning/deck versioning, and concurrent
  workflow replay ownership.
- `pnpm eval:offline`: validates the 15-case taxonomy, rubric gate, and seeded
  grader failures. It is not evidence of live-model quality.
- `pnpm qa:e2e`: starts an isolated fixture server and runs the critical browser
  journeys in an existing system Chrome. Playwright browser downloads are not
  required. Its current configuration retains trace/screenshots on failure, so
  treat each run as a separately authorized recording action.
- `pnpm harness:case`: runs one scripted fake-model case through the real bounded
  tool/controller path and writes a redacted bundle under `.artifacts/agent-runs/`.
- `pnpm harness:replay`: verifies event ordering and reconstructs the terminal
  phase without calling a model.

Real calls, external transfer, and API cost were authorized on 2026-10-14. Once
the key and pinned model are present, the synthetic-only live eval gates are:

```sh
PITCHROOM_LIVE_EVAL_ACK=synthetic-only OPENAI_API_KEY=... OPENAI_MODEL=... pnpm eval:live:smoke
PITCHROOM_LIVE_EVAL_ACK=synthetic-only OPENAI_API_KEY=... OPENAI_MODEL=... pnpm eval:live:all
```

Smoke selects five categories before the full model set. A critical failure
stops the batch, and each batch keeps its own artifacts.

Fresh non-recording browser QA passes for the complete synthetic local loop.
The updated recorded Playwright loop was not run in the 2026-10-15 verification.
Live model evaluation, deployment readiness, and real-user acceptance remain
separate evidence gates; authorization must not be mistaken for a pass.

## Clarify feedback loop (review_required only)

`Save answer & reassess` records the exact answer and a version/material snapshot,
then queues a task. The current understanding stays unchanged until the user
reviews the proposed interpretation and explicitly applies it. Apply creates one
new review-required version with parent/task lineage. Accepting that version is
still a separate action. No-change results, dismissal, failed attempts and stale
proposals retain the saved answer. Only one unresolved task is allowed per project.

The fixture uses an in-process deterministic executor for isolated UI testing.
Persistent projects require migration `0009_clarification_feedback` and a separate
worker; the web request never launches a detached persistent job. Existing
PostgreSQL deployments must apply the migration before serving this version.
No migration is executed by `pnpm check`.

```sh
# On an explicitly selected test database:
DATABASE_URL=... pnpm db:migrate
DATABASE_URL=... pnpm worker:clarify
# Process at most one available task:
DATABASE_URL=... pnpm worker:clarify -- --once
```

Supply the worker environment explicitly. The default worker processes only
synthetic tasks; live tasks require `--live`, a pinned model, credentials and
`PITCHROOM_LIVE_TRANSFER_ACK=authorized`. Do not start a live worker without
separate authorization. The live adapter is implemented but not live-validated.
Worker leases last 90 seconds, model work is bounded to 60 seconds, and expired
leases allow at most three automatic attempts. Failed analyses require explicit
retry. Recovery restarts analysis from its saved snapshot, not mid-model-step.

The first slice supports stable theme/claim IDs, summary interpretation changes,
retaining exact user answers and a next-question proposal. It does not modify
source-backed claims or resolve gaps automatically. User edits and Agent
interpretations remain distinguishable from source facts.

The persistent synthetic QA harness requires a dedicated disposable database:
`clarify_qa`, user `clarify_qa`, on localhost port `55437`. It refuses other
connection targets and never reads `.env.local`. Apply migrations first, then run:

```sh
DATABASE_URL=... pnpm --filter @pitchroom/persistence exec vitest run src/repository.integration.test.ts src/clarification.integration.test.ts src/clarification-structure.integration.test.ts
DATABASE_URL=... pnpm qa:clarify:persistent
```

The harness creates synthetic projects and launches separate synthetic worker
processes. It checks saved answers, proposal readback, edited/idempotent Apply,
failed retries, no-change/dismissal and live-queue isolation. Crash recovery kills
one test worker with SIGKILL, expires only that synthetic task's lease to avoid a
90-second wait, restarts a worker and checks stale-owner fencing. No live worker
is launched. Dispose of the entire dedicated test database after verification.

### Clarify judgment acceptance (offline)

```sh
pnpm --filter @pitchroom/evals eval:clarify:offline
```

Eight approved FlowDesk cases live in `packages/evals/src/clarification-cases.ts`.
They contain original answers and must-change/preserve/not-change contracts.
The command runs the current deterministic runner, prints observed proposals and
per-check results, and exits **1** if acceptance gaps exist. These failures are
not expected-failure tests and are not converted to green. `pnpm check` separately
tests the grading harness with positive and negative controls; its success does
not imply judgment acceptance.

Cases 1–5 start independently. Cases 6–7 use explicitly accepted reference
prerequisites (including saved earlier answers) to isolate failures; a separate
1 → 6 → 7 chain runs actual outputs with simulated in-memory Apply. Case 8 tests
the domain stale guard and reassessment on an updated source snapshot, not a
PostgreSQL/API rebase. No database, browser or model API is used. Structural and
phrase checks are necessary proxies, not proof of semantic quality. Each case
retains a pending human rubric; real-model behavior requires separate authorized
execution and human review. The deterministic runner’s judgment rules are unchanged; its result envelope now uses v4 shared attribution and theme grounding.

### Clarify structure v2

The v2 contract introduced `schemaVersion: 2` (new executions now use v4 below). `next_question.relatedThemeIds` is validated
against the saved understanding and converted to its current theme indexes; UI
labels follow those associations. Existing unversioned/v1 task results remain
readable and retain their original associations. Apply edits cannot downgrade a
v2 result. These additive fields live in existing JSONB payloads; no additional
SQL migration is required after `0009_clarification_feedback`.

`supersede_user_assertion` targets an active prior user claim and requires an
updated summary plus the exact new answer in the same theme. Original statements
remain with a `supersededBy` link; source-backed claims cannot be superseded.
Manual edits also retain the user-assertion correction chain. New model and
Positioning/Deck request contexts separate or exclude superseded assertions.
This records a correction relationship, not proof that its meaning is correct.

A rebase records `reassessment.rebasedFromTaskId`, the original understanding and
question, and added/removed/changed source IDs computed by the server. It reuses
the saved input and captures the current question separately. Material changes
still require a fresh review-required understanding before reassessment.

`packages/agent/src/clarification-model.test.ts` exercises the formal AI SDK
runner with an offline provider, including tools, invalid outputs, timeout and
current/history context separation. `clarification-structure.integration.test.ts`
adds isolated PostgreSQL multi-round Apply, retries, readback, correction and
rebase checks; it refuses targets other than the dedicated QA database above.
These mechanism checks do not change or pass the eight semantic acceptance cases.

### Clarify v3: attribution, question grounding and current applicability

The historical v3 contract uses `schemaVersion: 3`; existing v1/v2
results remain readable without invented metadata. New executions use v4 below.
Historical attempts retain their original prompt version. The deterministic
runner retains its original limited decision rules; its new grounding explicitly
labels it as an unverified mechanism demonstration, not semantic acceptance.

- Public `reasonBasis`, summary `basis`, and question grounding distinguish quoted
  **material records/requirements**, attributed **user reports**, and **Agent
  suggestions/interpretations**. Each carries scope. Only material bases may use
  the `requirement` force; user reports cannot become verified requirements.
- `next_question.grounding` identifies an objective, a primary theme, and an
  unresolved issue and rationale for exactly every related theme. A useful next
  question may address a different theme from the one changed by the answer.
- Each updated summary addresses current applicability of every preserved material
  claim in that theme: `confirmed`, `differs`, or `unconfirmed`, with a current
  interpretation, explanation and basis. This is version-local interpretation;
  original claim text, evidence and evidenceState are unchanged. Confirmation
  cannot rest solely on an Agent inference.
- Local checks reject missing/duplicate associations, invalid snapshot input IDs,
  missing/cross-source/false quotes, invalid applicability references and bases
  citing quarantined content. These checks prove reference validity and explicit
  attribution, **not that a quote entails a requirement or an explanation is true**.
- Basis and applicability persist in optional understanding metadata, accompany
  subsequent Clarify/Positioning/Deck contexts, and are inspectable in the proposal
  UI. Old understanding versions do not gain fabricated grounding.
- Apply can edit summary wording only; it cannot downgrade a proposal or rewrite
  its Agent basis, question or applicability. Original and applied results remain
  separate. Edited summaries carry `user_edited_unreviewed`; the visible UI and
  downstream prompts state that the original Agent basis does not endorse the
  edited wording. JSONB key ordering is ignored when comparing unchanged fields.

The existing JSONB payloads carry these additive fields; no new SQL migration is
needed after `0009_clarification_feedback`. The live-session code fingerprint now
includes the grounding schema. Changed code requires a fresh authorized session;
old results and budget ledgers are preserved. No model/API requests or budget
increases are implicit in this upgrade. The existing 2,000-output-token request
cap is unchanged; v3 adds output overhead, whose real-provider behavior remains
unverified.

Offline coverage includes the actual formal tool loop with a scripted provider,
scoped requirements and suggestions, cross-theme and joint questions, old records
with new goals, bad references, legacy compatibility, JSONB key reordering,
user edits, downstream context and DeepSeek Schema conversion. The isolated
PostgreSQL structure suite also checks v3 readback from another connection,
edited/idempotent Apply, downgrade/tamper rejection and failure preservation.
These do not change the eight approved case contracts or their grading rules.

### Clarify v4: shared bases, modality and failure stages

New formal and synthetic executions use `schemaVersion: 4` and prompt version
`clarify-feedback-v4`. Persisted v1/v2/v3 results and their historical Apply paths
remain readable as originally recorded. No old `force` values are reclassified.
The existing JSONB payloads carry v4; no SQL migration is added.

**One shared basis table per proposal.** `bases` contains bounded, uniquely named
entries. Public reason uses `reasonBasisRefs`; summary changes use `basisRefs`;
applicability and `next_question.groundingV4` use the same IDs. Duplicate IDs,
duplicate content under another ID, dangling/repeated references and unused table
entries are rejected. Understanding metadata persists the referenced subset with
its original IDs, so downstream contexts can resolve references without copying
an independently generated classification at every use.

Each basis independently names:

- `origin`: `material`, `user`, or `agent`;
- `nature`: `record`, `suggestion`, `requirement`, `interpretation`, or `uncertain`;
- `statement`, `scope`, and source quotes or user-input references as appropriate.

A material suggestion is now representable directly. A user-reported requirement
remains an unverified user report. A requirement must identify issuer, constrained
action, condition and an exact supporting quote in the cited material or user's
recorded words. Other natures require `requirement: null`; Agent inferences cannot
establish requirements. Local checks establish attribution, quote existence and
field consistency, **not that an authentic quote entails necessity**. When unsure,
the model must retain `uncertain` rather than invent agreement or a constraint.
UI labels are derived from this shared structured classification. Summary-only
manual editing retains the original basis and the user-edited/unreviewed warning;
Apply cannot rewrite classifications, associations or the contract version.

**Question association is tied to the actual question.** Each association requires
an exact `questionSpan` and the `expectedAnswer` that would fill that theme's
unknown, alongside objective, primary theme and rationale. A span absent from the
question is rejected. Instructions distinguish a directly requested answer from
background relevance, hypothetical consequences or possible later questions.
Explained joint questions remain supported; next questions need not target the
same theme as a summary change. Span membership is a mechanical check, **not proof
that the question really resolves the alleged unknown**; semantic human review
remains required. The synthetic runner keeps its original limited judgment rules.

**Failures are classified, never repaired.** `ClarificationFailureDiagnostic`
records a bounded code and stage: `provider`, `syntax`, `schema`, `reference`,
`judgment` (local contradictory declarations), `budget`, or `execution`. Syntax
failures include a bounded/redacted excerpt and offset where available. Schema
failures keep issue paths and codes, not arbitrary provider/Zod messages. Hidden
thoughts and credentials are excluded. Failure details travel through runner
callbacks, `attempts[].failure`, API readback, UI and evaluation reports.

The budget transport records HTTP/response status and allowlisted incomplete
reasons. Known usage settles before stopping on explicit incomplete/failed/refused
provider output; missing/unknown usage retains its reservation. An HTTP-200
`completed` message with invalid JSON still fails strict parsing. SDK no-object
errors are classified into syntax/schema/provider failures. There is no JSON
repair, retry or fallback provider, and no budget increase. The formal runner's
existing deadline is also enforced when a provider ignores cancellation.

The live acceptance phase now stops after any execution failure, preserving that
outcome and marking later cases `not_run_after_failure` (budget stops retain
`not_run_budget`). It never spends on another case to compensate for a format or
reference failure. This does not change the eight semantic case contracts,
automatic grading rules or human review gates. Existing live ledgers and results
are immutable; a new implementation fingerprint requires a fresh authorized run
with the prior cumulative costs/reservations carried forward.

Offline tests cover the formal SDK/tool loop, strict DeepSeek wire conversion,
HTTP-200 invalid JSON, truncation/refusal, schema/reference/contradiction failures,
redaction, independent source/modality combinations, genuine joint questions,
legacy reads/Apply, edited wording and downstream contexts. Isolated PostgreSQL
coverage includes v4 cross-connection readback, unified bases, edited/idempotent
Apply, tamper rejection, and persisted syntax failure without implicit retry.
These checks do not prove real-provider compatibility or semantic quality.

### Bounded Clarify real-model acceptance entry (not live-validated)

`pnpm --filter @pitchroom/evals eval:clarify:live` prints help and performs no
network operation by default. It never loads `.env.local`, starts a worker, or
opens a project database. This entry is separate from the older general live
eval commands; only this entry has the round-wide Clarify budget gate.

OpenAI configs retain the dated model snapshot, explicit HTTPS `/v1` endpoint,
caller-verified upper input/output rates, token-count fee, pricing source and check
time. Existing configs without `provider` still use that exact-count path.

DeepSeek uses `packages/evals/config/clarify-deepseek.json`, with an explicit
`provider: "deepseek"`, the official root endpoint and `deepseek-flash` alias.
The reviewed configuration records the observed `DeepSeek-V4.1-Flash-1017`
version, `high` reasoning effort, whole-context accounting and peak cache-miss
ceilings ($0.30/M input, $1.20/M output), checked on 2026-10-25 China time.
This is an observed version, **not a pinned snapshot or an automatic verification
of the currently served version**. Response model identity and optional system
fingerprint are recorded; a same-alias backend change cannot be detected reliably.
Recheck official version, context limits and prices before authorizing a live run.
The config deliberately permits only this reviewed endpoint/alias/version and
ceilings at least as high as those prices; a future version needs a reviewed update.
The entry never reads keys or model settings from `.env.local` automatically.

After separate authorization for a real evaluation, the workflow is:

```sh
# No model/key access: validates config and creates a fresh local session.
pnpm --filter @pitchroom/evals eval:clarify:live --prepare --config /absolute/path/to/clarify-deepseek.json
# Requires --authorize-synthetic-transfer, PITCHROOM_LIVE_TRANSFER_ACK=authorized
# and OPENAI_API_KEY in the explicitly supplied environment. Do not run without approval.
pnpm --filter @pitchroom/evals eval:clarify:live --run --session /absolute/session-dir --authorize-synthetic-transfer
# Inspect outputs and fill reviews.json; this is a human gate, never an auto-pass.
pnpm --filter @pitchroom/evals eval:clarify:live --continue-chain --session /absolute/session-dir --authorize-synthetic-transfer
# Read final human acceptance without any network/model operation:
pnpm --filter @pitchroom/evals eval:clarify:live --status --session /absolute/session-dir
```

The first phase attempts the eight approved cases once, with reference
prerequisites explicitly labelled. Case 8 makes one model execution on the new
snapshot; stale-Apply protection is covered by existing mechanism tests. Case 1's
actual output is reused in a 1 → 6 → 7 chain. Each continuation advances one step
only after an output-hash-bound human review passes. Failed prerequisites block
the chain; they are not replaced by reference answers. Reviewers must fill all
five dimensions, reviewer name, notes and critical errors. All eight independent
cases and both extra chain results must pass; missing reviews remain pending.
Offline-provider tests can satisfy mechanism criteria but never real acceptance.

Limits persist across explicit continuations: 10 Agent executions, 6 generation
steps each, 60 total HTTP requests, 20,000 generated output tokens and US$3.
Each request caps output at 2,000 tokens, including reasoning. The formal runner
keeps its existing 12-tool/60,000-tool-character and 60-second per-execution
limits. SDK retries are disabled (`maxRetries: 0`). No case is automatically
retried after semantic or execution failure; execution failures stop the phase.

- **OpenAI:** count input using `/responses/input_tokens`, then reserve exact
  counted input and maximum output cost before generation. Counting must work;
  there is no character-estimate fallback. The 120,000-input-token cap is a
  pre-dispatch bound. Counting and generation share the HTTP budget (at most
  30 generation requests).
- **DeepSeek:** no documented exact-count endpoint is assumed or called. Reserve
  1,048,576 input tokens (the reviewed whole-context capacity) plus capped output
  before each request, at peak cache-miss rates. Set `reasoning.effort=high` at
  the transport boundary because the generic OpenAI SDK does not recognize the
  DeepSeek model family. Settle using total returned `usage`, without cache
  discounts or separately adding reasoning tokens. A 2,000-output request reserves
  316,973 micro-USD (about $0.317). Keep an explicit **30-generation-request** cap
  even though there are no count requests. The cumulative 120,000-input-token
  value is a **post-response stop threshold**, not a hard token cap: the crossing
  request has already been billed. Reports label this difference. `countRequestMicroUsd=0`
  means no counting request is sent, not that an undocumented endpoint is free.

Missing usage, network/HTTP errors, changed response model identity or exceeded
provider bounds stop the batch and retain the full unknown reservation. Remaining
budget must cover the whole next reservation; otherwise no request is sent.
The US$3 bound relies on the provider honoring the reviewed price and context/output
limits, and covers this session's model calls only. At the target 120,000 input
and 20,000 output tokens the peak-price estimate is $0.060, not a guaranteed total
since DeepSeek input is stopped after usage returns. No hosted Search/Fetch tools
are enabled. Local source functions are the only allowed tools.

Official contracts: [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/),
[Responses compatibility](https://api-docs.deepseek.com/guides/responses_api/),
[token usage](https://api-docs.deepseek.com/quick_start/token_usage/),
[context metadata](https://api-docs.deepseek.com/api/list-models/), and
[OpenAI token counting](https://developers.openai.com/api/docs/guides/token-counting).

For DeepSeek only, the acceptance transport converts output-schema `oneOf`
nodes to `anyOf` when every alternative is an object with a required string
constant discriminator and all discriminator values differ. This proves the
branches are disjoint, so the conversion preserves their meaning. Unproven or
overlapping unions stop before transfer (`UNSUPPORTED_OUTPUT_SCHEMA`); there is
no automatic JSON-mode fallback. Only schema positions are traversed; annotation
data and property names remain unchanged. All branch constraints, strict output
settings, the original domain Zod schema and candidate validation remain intact.
The actual adapted request is recorded in the reservation journal, and adapter
source is included in the code fingerprint. OpenAI schemas are unchanged. Offline
coverage proves this specific wire transformation and continued local rejection
of invalid outputs; it does not prove DeepSeek accepts all remaining keywords.

HTTP failures now create a bounded `http_error` diagnostic for both generation
and token counting. JSON bodies retain only scalar `message`, `type`, `code` and
`param` fields (including providers with a string `error`). Actual request
credentials, common key/token forms and values found in sensitive/hidden-thinking
fields are redacted before journaling. Messages containing hidden-content markers
are omitted. Arbitrary fields and response/request headers are not persisted.
Non-JSON/HTML bodies, bodies over 16 KiB and read failures retain HTTP status plus
an explicit omission reason; they are never written as raw text. Retained fields
are bounded to 2,000 characters. The report includes these sanitized diagnostics;
HTTP rejection remains an execution failure, with no retry or unknown-cost refund.
This does not recover omitted error bodies from earlier runs or authorize replay.

Records stay in `.artifacts/clarify-live/<unique-session>/`, gitignored and
restricted to local file permissions. A session records config/limits, code and
case hashes, actual task snapshots, sanitized model outputs, tool calls/results,
usage/charge ledger, per-case checks and human-review templates. Hidden reasoning,
headers and credentials are excluded. Automatic checks validate structural
preservation and associations; semantic question relevance and necessity remain
human judgments. Correction metadata may be added while original statement text,
evidence and attribution stay immutable. The approved case file and the original
deterministic offline grading path are unchanged.

A hash-chained journal and exclusive writer lock prevent silent overwrites and
budget resets. A crashed process leaves its lock: there is no automatic restart,
lock removal, spend refund or fresh-session retry. Code/config changes invalidate
continuation. Each session is capped at 2 MB and preparation/continuation checks
the aggregate 320 MB evidence allowance using metadata only; no old evidence is
deleted. Existing tests exercise all of this using offline HTTP substitutes;
no real provider compatibility, pricing, token counts or judgment quality has
been established by those tests.


### 2026-10-25 calibration acceptance (current scoped round)

Five user-requested repairs and real DeepSeek synthetic-material browser chain completed, without commits. PDF/assistive technology deferred by user. 385 tests, 17 PostgreSQL checks, 7 browser journeys; standalone build passed, aggregate command security-notice interruption retained. Original eight criteria unchanged; case 7 legacy keyword false-negative remains explicitly recorded. See [scoped report](docs/verification/2026-10-25-calibration-dod.md). This is engineering/assistant acceptance, not customer acceptance.
