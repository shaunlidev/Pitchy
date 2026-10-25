# Harness status

> **2026-10-25 first-loop verification:**受众修订、自由故事判断、真实变化预览、明确采用与 Deck 追溯已在隔离合成项目中用真实 DeepSeek 跑通。已验证原样承接、Keep、Undo、人工编辑/旧稿、过期提示和重启恢复。此结论属于修复后的首批闭环验收，不代表首次生成可靠性、客户验收或上线就绪。原验收标准保持不变。详见 [本轮证据与限制](.artifacts/first-loop-20261025/acceptance-report.json)。Next.js 安全公告仍待处理。


> **2026-10-25 current verification:** a fresh `pitchroom-app/` implementation exists. The live web journey has now exercised real DeepSeek Understanding → worker Clarify → Positioning → Deck on an isolated synthetic PostgreSQL project. This supersedes older “not built / live not run” status statements for that narrow scope. Product acceptance remains **not passed**. See [full test matrix, DoD, actual failures and correction plan](docs/verification/2026-10-25-live-full-flow.md).

The dated audit below is retained as historical evidence. Its counts and live-status labels are not the current campaign result.


Last verified: 2026-10-15

This file separates implementation evidence from planned or authorized-later work.

| Layer | Status | Evidence |
|---|---|---|
| Type safety | PASS | `pnpm typecheck` across domain, agent, persistence, evals, testkit, and web |
| Deterministic tests | PASS | 110 tests: domain 21, testkit 3, agent 33, evals 7, web 46. Includes Deck contracts, Positioning/Deck mocked provider adapters, explicit adjustment/re-apply, UI state, and stale/history behavior |
| PostgreSQL integration | PASS | 9 non-destructive repository contracts against local PostgreSQL 17, including Positioning/Deck versioning and concurrent workflow idempotency ownership. The harness no longer truncates local project tables |
| Security regression | PASS | material cannot reopen review/accepted projects; only one concurrent run acquires project ownership; a completed run cannot later clobber project phase |
| Production build | PASS | fresh Next.js 16.4 build with `/`, health, workspace, and event stream routes |
| Synthetic HTTP flow | PASS | material → run → review → correction → stale approval rejection → current approval |
| Persistent HTTP flow | PASS | PostgreSQL-backed flow reached accepted with 2 versions; process restart readback passed |
| Offline eval harness | PASS | 15 Understanding cases plus an independent Deck grader for schema/order, exact evidence, current upstream IDs, applied direction, and preserved unknowns |
| Case artifact + replay | PASS | all 15 cases traversed the bounded controller/tool path (user correction uses its distinct input/version path), produced redacted bundles, and replayed to `review_required`; total local size 360 KiB |
| External model adapters | IMPLEMENTED, MOCK-VALIDATED, NOT LIVE-VALIDATED | bounded Understanding tool loop plus structured Positioning/Deck Responses adapters; pinned model/config, exact evidence, upstream IDs, persistent workflow events, replay semantics, and fail-closed config |
| Live eval command | IMPLEMENTED, NOT RUN | five-category smoke then full synthetic set; explicit transfer acknowledgement, pinned model, critical-failure stop, immutable batch artifacts |
| Live model eval | NOT RUN | calls, transfer, and cost are authorized; `OPENAI_API_KEY` and pinned `OPENAI_MODEL` are absent |
| Browser functional QA | PASS | fresh isolated non-recording journey covered Materials → Clarify → Positioning adjustment → fresh Apply → five-page Deck → edit/history → upstream stale warning; Project overview was clickable and console warnings/errors were 0 |
| Repeatable browser E2E | IMPLEMENTED, NOT FRESHLY RUN | existing five journeys were repaired for the current intake UI and a sixth complete-loop journey was added; no run because failure traces/screenshots require fresh recording authorization |
| Responsive visual QA | PASS | production fixture inspected at 1280×720, 768×1024, and 375×812; no overlap, clipping, horizontal overflow, or console errors; local screenshots and QA report retained under `.gstack/qa-reports/` |
| Human acceptance | NOT RUN | requires user review of the running interaction |
| Deployment | NOT RUN | authorized on 2026-10-14; production identity, privacy/retention, database/backup, hosting, and rollback decisions remain open |

## Current command gates

```sh
pnpm check
pnpm test:server
pnpm eval:offline
pnpm qa:e2e
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


### 2026-10-25 calibration acceptance (current scoped round)

Five user-requested repairs and real DeepSeek synthetic-material browser chain completed, without commits. PDF/assistive technology deferred by user. 385 tests, 17 PostgreSQL checks, 7 browser journeys; standalone build passed, aggregate command security-notice interruption retained. Original eight criteria unchanged; case 7 legacy keyword false-negative remains explicitly recorded. See [scoped report](docs/verification/2026-10-25-calibration-dod.md). This is engineering/assistant acceptance, not customer acceptance.
