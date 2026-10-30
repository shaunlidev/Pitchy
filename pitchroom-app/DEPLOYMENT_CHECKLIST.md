# Deployment readiness checklist

## Current configuration increment — PIT-34

The [runtime configuration contract](RUNBOOK.md#runtime-configuration)
now separates local configuration validity from deployment readiness. Declared
deployments refuse readiness until actual target, schema, worker and authorization
checks are verified. Production startup does not silently fall back to fixture.

This is a bounded configuration change, not deployment authorization or completion
of PIT-34. The original acceptance gates, independent review/QA, integration and
human release approval remain required. No live database, provider or hosted
environment was exercised for this increment.

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
