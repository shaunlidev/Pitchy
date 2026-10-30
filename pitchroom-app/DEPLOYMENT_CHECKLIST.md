# Deployment readiness checklist

## Current bounded increment — PIT-34

The [runtime contract](RUNBOOK.md#runtime-configuration) now observes actual
connection identity, the full migration ledger and compatible worker heartbeats.
Deployed TLS requires certificate and hostname verification. Migration 0013 adds
empty metadata tables; runtime processes never initialize environment identity or
run migrations. Local fixture behavior is retained.

| Current gate | Meaning / remaining evidence |
|---|---|
| Configuration | Explicit environment, release, target, role, environment UUID, accepted-target receipt SHA, provider and model declarations |
| Database target | Actual DB/role/public schema and initialized identity agree; real cloud account/project/branch receipt still needs PIT-32 acceptance |
| Schema | Complete ordered migration hashes and timestamps match the compiled release; unknown newer versions refuse |
| Worker | One compatible fresh process; startup/claim checks, independent heartbeat and stop/expiry behavior |
| Authorization / budget | **NOT READY** — remains false pending PIT-39/55 enforcement; no invented approval |
| Real target, migrations, hosting, recovery | **NOT RUN** — isolated synthetic tests do not authorize or prove real provisioning/deployment |
| Exact-version delivery | Fresh independent Reviewer, then QA and CI; reports must identify their immutable head |
| Main integration | PR-head CI does not prove the combination with a changed main; PIT-84 delivery gates remain unchanged |
| Human trial acceptance | **NOT RUN** — user/task quality, real-model quality and 3–5-person trial remain separate |

This change is not completion of the full PIT-34 contract. Raw verification logs
remain local. No real database, model, hosted environment or customer material is
needed for the synthetic checks. Overall deployed health remains HTTP 503 until
actual authorization and budget checks exist.

## Historical baseline — not current deployment acceptance

The record below is retained as historical evidence. Its dated permissions and
PASS labels do not authorize a new deployment or establish the current trial's
readiness; use current explicit authorization and version-bound evidence.

Status values are `PASS`, `FAIL`, or `NOT RUN`. Deployment was authorized by the
user on 2026-10-14; this checklist determines whether that authorized action is
safe to execute.

| Gate | Status | Evidence or blocker |
|---|---|---|
| Production build | PASS | `pnpm build` |
| Empty-database migration | PASS | local PostgreSQL 17 rehearsal |
| Upgrade migration with existing rows | PASS | `created_by` backfill path exercised |
| Repository contract tests | PASS | 4 contracts via `pnpm test:server`, including aggregate size and cancel/retry |
| Health/readiness route | PASS | fixture and fail-closed live tests |
| Authentication/authorization | NOT RUN | synthetic actor only; design required |
| External provider privacy review | NOT RUN | transfer is authorized, but retention/deletion terms and production data policy are not selected |
| Live model eval thresholds | NOT RUN | calls and cost are authorized; `OPENAI_API_KEY` and pinned `OPENAI_MODEL` are absent |
| Browser functional QA | PASS | five isolated Playwright journeys plus manual core, conflict, recovery, stale-write, disconnect/reload, and keyboard checks; remaining live-runtime and human judgments are separate rows |
| Browser responsive visual QA | PASS | production fixture inspected at desktop, tablet, and mobile widths with no console errors |
| Assistive-technology/human acceptance | NOT RUN | bound labels and keyboard flow pass; screen-reader interpretation and user acceptance remain separate gates |
| Backup/restore rehearsal | NOT RUN | operator backup destination not selected |
| Hosting and rollback | NOT RUN | deployment is authorized and Vercel CLI is authenticated; production database, identity boundary, and rollback target are not selected |
| Human acceptance | NOT RUN | user must review the live interaction |

Deployment execution: **NOT READY** until every production `NOT RUN` gate has
evidence. No additional generic deployment permission is required; concrete
configuration and safety decisions are still required.
