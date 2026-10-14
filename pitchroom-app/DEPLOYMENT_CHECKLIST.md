# Deployment readiness checklist

Status values are `PASS`, `FAIL`, or `NOT RUN`. This document is not deployment authorization.

| Gate | Status | Evidence or blocker |
|---|---|---|
| Production build | PASS | `pnpm build` |
| Empty-database migration | PASS | local PostgreSQL 17 rehearsal |
| Upgrade migration with existing rows | PASS | `created_by` backfill path exercised |
| Repository contract tests | PASS | 4 contracts via `pnpm test:server`, including aggregate size and cancel/retry |
| Health/readiness route | PASS | fixture and fail-closed live tests |
| Authentication/authorization | NOT RUN | synthetic actor only; design required |
| External provider privacy review | NOT RUN | provider transfer not authorized |
| Live model eval thresholds | NOT RUN | no authorized live calls |
| Browser functional QA | PARTIAL | isolated non-recording core journey passed; remaining journeys are tracked in `BROWSER_QA_MATRIX.md` |
| Browser visual/accessibility acceptance | NOT RUN | screenshot-based responsive review, full keyboard/screen-reader review, and user acceptance remain separate gates |
| Backup/restore rehearsal | NOT RUN | operator backup destination not selected |
| Hosting and rollback | NOT RUN | deployment destination not authorized |
| Human acceptance | NOT RUN | user must review the live interaction |

Deployment decision: **BLOCKED** until every `NOT RUN` production gate has evidence
and the user separately authorizes deployment.
