# First-slice completion audit

Last audited: 2026-10-14

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
| T70 Materials/Clarify UI | FUNCTIONALLY QA'D; VISUAL QA NOT RUN | pure React view is separated from effects; an eight-phase server-rendered component matrix covers empty/materials/reading/structuring/cancelled/failed/review/accepted plus error/busy/cancel semantics; isolated browser flow covered material, run, review, answer, correction, keep-unknown, acceptance, reset, keyboard order, accessible names/structure, warmed performance, and a clean console; production build passes | screenshot-based responsive/pixel review, screen-reader, two-tab, disconnect, and human acceptance evidence is missing |
| T80 offline evals | PASS | 15 versioned cases, deterministic graders, human rubric thresholds, five-category live selection, redacted artifacts, replay | rubric scores require human review |
| T90 real model integration | IMPLEMENTED; NOT RUN | live PostgreSQL runtime, Vercel AI SDK tool agent, abort/timeout/budget controls, usage/trace capture, explicit transfer acknowledgement, smoke/full live-eval commands | explicit external-transfer authorization, credentials, API cost, five-output review, and full live thresholds |
| T100 browser QA | PARTIAL PASS | non-recording black-box QA completed in an isolated synthetic worktree; core workflow, terminal accepted state, accessible tree, console, and warmed performance were checked; one medium review-form defect was repaired and reverified | screenshots/recordings were not authorized, so responsive/pixel visual QA and user acceptance remain open |
| T110 operational hardening | PARTIAL | health/readiness, request/source/project budgets, cancellation, migration recovery procedure, completed 97-file security scan, remediated state-transition and concurrent-run findings, runbook, production build | authentication/authorization, CSRF/origin, production rate/cost limits, privacy/retention/deletion, backup/restore, hosting/rollback, deployment decision |

## Current verified commands

```text
pnpm check                 PASS (75 deterministic tests + production build)
pnpm test:server           PASS (7 PostgreSQL contracts, including concurrent run serialization and replay)
pnpm eval:offline          PASS (6 harness/grader tests; 15-case set exists)
harness:case x 15          PASS (fresh scripted-controller artifacts)
harness:replay x 15        PASS (terminal review_required reconstructed)
qa:persistent-http         PASS (10 durable events; stale approval rejected)
qa:persistent-readback     PASS (accepted state survives process restart)
empty database migration   PASS (0000–0005; cancelled enum inspected)
live model eval            NOT RUN
browser functional/a11y QA PASS (non-recording isolated synthetic flow)
browser visual pixel QA    NOT RUN
human acceptance           NOT RUN
deployment                 NOT RUN
```

## Completion decision

The authorized local implementation is harness-green. The complete plan is not
yet globally complete because T90 live-model evidence, T100 browser/human
evidence, and the production-only portion of T110 require external transfer,
working browser control, user judgment, or deployment decisions. Those states
remain explicit rather than being converted into inferred success.
