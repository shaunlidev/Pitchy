# Harness status

Last verified: 2026-10-14

This file separates implementation evidence from planned or authorized-later work.

| Layer | Status | Evidence |
|---|---|---|
| Type safety | PASS | `pnpm typecheck` across domain, agent, persistence, evals, testkit, and web |
| Deterministic tests | PASS | 67 tests across domain, persisted-agent service, tool/wall-clock/output/failure budgets, web API/SSE/health/UI state, source reconstruction, eval grader/rubric/live-selection gates, artifacts, and terminal-state material guards |
| PostgreSQL integration | PASS | full empty-database migration rehearsal plus 7 repository contract tests against local PostgreSQL 17, including concurrent-run serialization, concurrent idempotent replay, and stale-terminal-write protection |
| Security regression | PASS | material cannot reopen review/accepted projects; only one concurrent run acquires project ownership; a completed run cannot later clobber project phase |
| Production build | PASS | Next.js build with `/`, `/api/workspace`, and event stream route |
| Synthetic HTTP flow | PASS | material → run → review → correction → stale approval rejection → current approval |
| Persistent HTTP flow | PASS | PostgreSQL-backed flow reached accepted with 2 versions; process restart readback passed |
| Offline eval harness | PASS | 15 initial cases; seeded evidence and budget violations are caught |
| Case artifact + replay | PASS | all 15 cases traversed the bounded controller/tool path (user correction uses its distinct input/version path), produced redacted bundles, and replayed to `review_required`; total local size 360 KiB |
| Vercel AI SDK adapter | IMPLEMENTED, NOT LIVE-VALIDATED | bounded `ToolLoopAgent`, structured output, real tools, abort propagation, tool/result/elapsed budgets, persisted trace/usage metadata, and fail-closed config |
| Live eval command | IMPLEMENTED, NOT RUN | five-category smoke then full synthetic set; explicit transfer acknowledgement, pinned model, critical-failure stop, immutable batch artifacts |
| Live model eval | NOT RUN | requires explicit external data/model authorization and credentials |
| Browser functional QA | PASS | isolated synthetic project covered material → run → review → answer/correction/keep-unknown → accept/reset; accessibility tree and console were inspected; one duplicate-submission defect was fixed and reverified |
| Visual pixel QA | NOT RUN | screenshots/recordings were not authorized, so responsive layout and pixel-level appearance remain unverified |
| Human acceptance | NOT RUN | requires user review of the running interaction |
| Deployment | NOT RUN | requires separate deployment authorization and production auth/privacy decisions |

## Current command gates

```sh
pnpm check
pnpm test:server
pnpm eval:offline
pnpm eval:live:smoke # explicit acknowledgement, key, and pinned model required
pnpm harness:case -- supported-growth
pnpm harness:replay -- eval-supported-growth
```

## Truth boundary

The scripted synthetic runner proves orchestration, tool access, bounded failure
recovery, provenance, state, version, replay, and approval behavior. It does not
prove that a real model produces useful or reliable understanding. Offline evals
prove grader mechanics and case coverage, not model quality.

## Bugs caught by the harness

1. An upgrade migration initially added `created_by NOT NULL` before backfilling
   historical rows. The real PostgreSQL migration failed; the migration now adds
   the column nullable, backfills `agent`, then applies `NOT NULL`.
2. A retried user correction was rejected as stale after its first request had
   advanced the revision. Idempotency lookup now precedes stale-write validation,
   while reuse of the same key for different content fails with `CONFLICT`.
3. Source-content deduplication initially returned an existing source without
   binding the new idempotency key. `command_receipts` now records the request
   hash and target resource, preventing later reuse of that key for other data.
4. Persistent UI reconstruction initially concatenated overlapping chunks and
   overstated material length. It now reconstructs by stable source offsets and
   has an out-of-order overlap regression test.
5. The live AI adapter originally bounded model steps but not elapsed time. It
   now sets total, per-step, and local-tool timeouts in the AI SDK request.
6. The first case CLI assembled expected proposals without traversing tools or
   the controller. Model-oriented cases now run a scripted `StepAgent` through
   the actual bounded loop; user correction remains a human-input/version path.
7. A transient tool error originally terminated the run immediately. The
   controller now allows bounded recovery, while budget/cancellation failures
   still terminate immediately.
8. Health checks described a `live` mode that workspace routes did not use.
   Live mode now selects PostgreSQL plus the Vercel adapter and requires a
   separate transfer acknowledgement.
9. SSE returned a completed snapshot and caused reconnect churn. It now holds a
   bounded stream open, emits new ordered events, and retains one-shot replay.
10. Stale approval now maps to HTTP 409 with `CONFLICT`; the HTTP QA contract was
    updated from its former generic-400 expectation.
11. Successful answer and correction actions left their draft text in the form,
    allowing an accidental second click to create a duplicate version. Successful
    submissions and synthetic reset now clear those drafts; browser revalidation
    confirmed both submit buttons return to disabled.
