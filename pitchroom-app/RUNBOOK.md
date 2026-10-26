# Local operator runbook

## Start

```sh
docker compose up -d postgres
DATABASE_URL=postgres://pitchroom:pitchroom@127.0.0.1:54329/pitchroom pnpm db:migrate
pnpm check
pnpm test:server
pnpm dev
```

Readiness: `GET http://127.0.0.1:3000/api/health`.

## Runtime modes

- `fixture` (default): synthetic local state and no external model/data transfer.
- `postgres-fake`: PostgreSQL-backed deterministic agent, used to verify the
  complete durable workflow without an external model; requires `DATABASE_URL`.
- `live`: PostgreSQL-backed external-agent runtime. Understanding uses the AI
  SDK tool loop; Positioning and Deck use the provider's OpenAI-compatible
  Responses endpoint. It requires
  `DATABASE_URL`, `OPENAI_API_KEY`, a pinned `OPENAI_MODEL`, and the explicit
  `PITCHROOM_LIVE_TRANSFER_ACK=authorized` transfer acknowledgement. Set
  `OPENAI_BASE_URL` when using a compatible provider such as DeepSeek.

Run `pnpm env:check` before starting a non-fixture runtime. Missing configuration
is a terminal configuration error; do not fall back silently.

Live eval uses a different acknowledgement,
`PITCHROOM_LIVE_EVAL_ACK=synthetic-only`. It authorizes only the versioned
synthetic cases and does not authorize sending user project material.

## Migration recovery

1. Stop application writes.
2. Back up the database using the operator's approved PostgreSQL mechanism.
3. Apply `pnpm db:migrate` to a restored/staging copy first.
4. Run `pnpm test:server` against that copy.
5. Apply to the target database only when both migration and contract tests pass.

Generated migrations are reviewed files. When adding a non-null column to a table
with rows, use add-nullable, backfill, then set-not-null. Rollback is restoration
from the pre-migration backup unless a reviewed inverse migration exists.

## Failure handling

| Symptom | Inspect | Safe action |
|---|---|---|
| Health returns 503 | runtime and boolean checks; never print secrets | restore required configuration |
| Run loops/repeats tools | ordered run events and budget counters | allow bounded failure; create a new run after repair |
| Evidence rejected | chunk ID, source ID, exact quote | keep proposal uncommitted; fix prompt/tool behavior |
| Stale revision conflict | current project revision/version | refresh; never force acceptance |
| Migration failure | SQL error and migration journal | stop writes; repair migration and rehearse on a copy |
| Provider failure | typed provider error, latency, retry count | bounded retry policy; do not switch providers silently |
| Positioning/Deck command outcome is uncertain | persisted `workflow_runs` row and command id | retry with the same command id; completed results are read back, running duplicates fail closed, and failed results are not silently rerun |
| User cancels a run | `run_cancelled` event and `cancelled` project state | retry as a new run; never reuse the cancelled run ID |

## Stop local services

```sh
docker compose stop
```

This preserves the local volume. Deleting the volume is intentionally not part of
the routine runbook.
