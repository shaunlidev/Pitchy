# V6 local-loop completion audit

> **2026-10-25 current verification:** a fresh `pitchroom-app/` implementation exists. The live web journey has now exercised real DeepSeek Understanding → worker Clarify → Positioning → Deck on an isolated synthetic PostgreSQL project. This supersedes older “not built / live not run” status statements for that narrow scope. Product acceptance remains **not passed**. See [full test matrix, DoD, actual failures and correction plan](docs/verification/2026-10-25-live-full-flow.md).

The dated audit below is retained as historical evidence. Its counts and live-status labels are not the current campaign result.


Last audited: 2026-10-15

## Complete local loop added after the first slice

| Area | Current state | Fresh evidence | Open gate |
|---|---|---|---|
| Materials and Clarify | PASS | source upload/paste, clickable Project overview, evidence review, explicit acceptance | human usefulness review |
| Positioning | PASS locally | original framing plus choices, exact evidence/tradeoffs, adjustment versions, Apply/Undo, durable workflow events and failures | live model output not run |
| Deck | PASS locally | fixed five-page schema, explicit Create Deck, edit creates draft 2, historical read-only view, stale preservation, Print / Save PDF affordance | actual print dialog/PDF visual output not inspected |
| Agent uncertainty | PASS | same workflow command is atomically owned once; completed replay reads state, in-flight replay conflicts, failed replay does not silently call the model | distributed/provider production observation |
| Deterministic verification | PASS | typecheck; 110 tests; 9 PostgreSQL contracts; production build | none for local deterministic scope |
| Synthetic browser acceptance | PASS | non-recording isolated complete loop; 0 console warnings/errors | user acceptance remains separate |
| Repeatable recorded E2E | IMPLEMENTED, NOT RUN | sixth complete-loop test plus repaired intake setup | fresh recording authorization |
| Live model | IMPLEMENTED, MOCK-VALIDATED, NOT RUN | adapter contract tests validate JSON schema, evidence and upstream targeting | successful authorized live smoke |

## Historical first-slice audit (2026-10-14)

This is a requirement-by-requirement audit of `IMPLEMENTATION_PLAN.md`. A green
lower layer is never used as evidence for an unrun higher layer.

| Plan item | State | Authoritative evidence | Remaining proof or blocker |
|---|---|---|---|
| T00 command surface and deterministic utilities | PASS | root scripts; `testkit` clock/ID/artifact tests; `pnpm check` | none |
| T01 event and artifact contracts | PASS | domain event schema, redacted atomic bundle writer, replay CLI, 15 replayed bundles | none |
| T10 PostgreSQL and migrations | PASS | Compose PostgreSQL 17; migrations 0000–0005; fresh empty-DB rehearsal including `cancelled` enum | production backup destination remains outside local implementation |
| T11 transactional repositories | PASS | 4 real PostgreSQL contracts: idempotency/project scope, atomic versions/stale writes, aggregate size, cancel/retry | none for the local slice |
| T20 ingestion and chunking | PASS | stable hash/IDs, newline normalization, binary/control rejection, 1 MiB source and 5 MiB project limits, six representative deterministic fixtures | browser file decoding uses fatal UTF-8; visual inspection remains a browser gate |
| T30 tools and budgets | PASS | four project-scoped tools; step, tool-call, repeat, consecutive-failure, returned-character, and elapsed-time tests | live provider behavior remains unvalidated |
| T40 fake agent loop | PASS | scripted `StepAgent` cases traverse real tools/controller; transient failure recovery, prompt injection, long-tail retrieval, conflicts, exact quotes, and replay are covered | fake output is not model-quality evidence |
| T50 review/version/approval | PASS | immutable agent/user versions, answer vs correction, keep-unknown, user attribution, stale/current approval, retry-safe inputs | human comprehension is not inferred |
| T60 HTTP/SSE | PASS for local slice | Zod command/response/event/error schemas; request IDs; 409 conflict envelope; bounded live SSE with Last-Event-ID; full PostgreSQL HTTP flow and restart readback | production auth, rate limiting, and hosting logs remain deployment blockers |
| T70 Materials/Clarify UI | FUNCTIONAL + RESPONSIVE VISUAL PASS | pure React view is separated from effects; eight-phase render and HomePage interaction tests pass; isolated manual and Playwright flows cover material, run, review, answer, correction, keep-unknown, acceptance, invalid-file recovery, reset, keyboard order, stale two-tab writes, SSE disconnect/reload, accessible names/structure, warmed performance, and a clean console; production screenshots pass at desktop/tablet/mobile widths | screen-reader, live-model disconnect/timeout, and human acceptance remain open |
| T80 offline evals | PASS | 15 versioned cases, deterministic graders, human rubric thresholds, five-category live selection, redacted artifacts, replay | rubric scores require human review |
| T90 real model integration | IMPLEMENTED; NOT RUN | live PostgreSQL runtime, Vercel AI SDK tool agent, abort/timeout/budget controls, usage/trace capture, explicit transfer acknowledgement, smoke/full live-eval commands; real calls, transfer, and API cost were authorized on 2026-10-14 | `OPENAI_API_KEY` and a pinned `OPENAI_MODEL` are absent; five-output review and full live thresholds therefore remain unrun |
| T100 browser QA | PARTIAL PASS | manual core QA, 5 repeatable Playwright journeys, and production responsive screenshots pass; upload/conflict, invalid-file recovery, SSE disconnect/reload, stale two-tab correction, keyboard activation, and three-width layout are evidenced; one medium defect was repaired with interaction regressions | screen-reader, live-model timeout/disconnect, and human acceptance remain open |
| T110 operational hardening | PARTIAL | health/readiness, request/source/project budgets, cancellation, migration recovery procedure, completed 97-file security scan, remediated state-transition and concurrent-run findings, runbook, production build | authentication/authorization, CSRF/origin, production rate/cost limits, privacy/retention/deletion, backup/restore, hosting/rollback, deployment decision |

## Current verified commands

```text
pnpm check                 PASS (77 deterministic tests + production build)
pnpm test:server           PASS (7 PostgreSQL contracts, including concurrent run serialization and replay)
pnpm eval:offline          PASS (6 harness/grader tests; 15-case set exists)
pnpm qa:e2e                PASS (5 system-Chrome journeys)
harness:case x 15          PASS (fresh scripted-controller artifacts)
harness:replay x 15        PASS (terminal review_required reconstructed)
qa:persistent-http         PASS (10 durable events; stale approval rejected)
qa:persistent-readback     PASS (accepted state survives process restart)
empty database migration   PASS (0000–0005; cancelled enum inspected)
live model eval            NOT RUN
browser functional/a11y QA PASS (non-recording isolated synthetic flow)
browser responsive visual  PASS (production desktop/tablet/mobile screenshots)
human acceptance           NOT RUN
deployment                 NOT RUN
```

## Completion decision

The authorized local implementation is harness-green. Browser tooling,
recording, real model calls, external transfer, API cost, local commits, and
deployment were authorized on 2026-10-14. Authorization is not evidence of a
successful gate: T90 still lacks credentials, T100 still needs screen-reader,
live-runtime, and user judgments, and T110 still needs concrete production
identity, retention, backup, hosting, and rollback decisions.


### 2026-10-25 calibration acceptance (current scoped round)

Five user-requested repairs and real DeepSeek synthetic-material browser chain completed, without commits. PDF/assistive technology deferred by user. 385 tests, 17 PostgreSQL checks, 7 browser journeys; standalone build passed, aggregate command security-notice interruption retained. Original eight criteria unchanged; case 7 legacy keyword false-negative remains explicitly recorded. See [scoped report](docs/verification/2026-10-25-calibration-dod.md). This is engineering/assistant acceptance, not customer acceptance.
