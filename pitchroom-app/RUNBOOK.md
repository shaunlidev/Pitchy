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

## Runtime configuration

PIT-34 configuration increment. This contract validates declarations before Web
requests, worker claims or the supported production start command proceed. It
does not establish permission to call a model or readiness to invite users.

### Environment and runtime

`PITCHROOM_DEPLOYMENT_ENV` accepts `local`, `staging`, `trial`, or `production`.
It is separate from `PITCHROOM_RUNTIME`, which accepts `fixture`, `postgres-fake`,
or `live`. An absent deployment environment defaults to `local` only outside
`NODE_ENV=production`. Unknown and empty values are errors. Production Node
processes require both fields explicitly, including isolated local fixture runs.

| Deployment environment | Permitted runtime | Additional conditions |
|---|---|---|
| Local Web | fixture, postgres-fake, live | Development/test may omit runtime to use fixture. Persistent modes require a valid PostgreSQL URL; live also requires key, model and transfer acknowledgement. |
| Local worker | postgres-fake, live | Legacy no-flag startup defaults to postgres-fake; `--live` selects live only when runtime is absent. A conflicting flag/runtime refuses startup. |
| Staging, trial, production | live, explicitly supplied | All deployment identity, target and provider declarations below are required. A fixture cannot satisfy a deployment check. |

Both processes use `packages/domain/src/runtime-configuration.ts`. The HTTP
workspace read/write and event-stream boundaries return a redacted 503 before
reading or changing state when configuration is invalid. The worker refuses
before creating a database client. The CLI reports `CONFIGURATION_VALID`, not a
deployment PASS. Validation makes no database or provider request.

### Required deployed declarations

| Variable | Contract |
|---|---|
| `PITCHROOM_DEPLOYMENT_ENV` | staging, trial, or production |
| `PITCHROOM_RUNTIME` | live |
| `PITCHROOM_RELEASE_SHA` | Full lowercase 40-character Git SHA |
| `PITCHROOM_SCHEMA_VERSION` | Exact SHA-256 fingerprint exported as `deploymentSchemaVersion` by the release migration manifest |
| `DATABASE_URL` | Canonically serialized PostgreSQL URL with credentials, one DNS/IPv4 host, explicit port and a literal database name (no percent encoding or path separators). TLS `sslmode=verify-full` only. Process-wide `NODE_TLS_REJECT_UNAUTHORIZED` must be absent or `1`. Query parameters are limited to sslmode, channel_binding and application_name, each appearing at most once. No fragment or connection-target override. |
| `PITCHROOM_DATABASE_TARGET` | Credential-free `host:port/database`, matching the supported URL exactly. The deployed URL must supply its port, so inherited `PGPORT` cannot change the client's target. This comparison does not attest actual server identity or credential isolation. |
| `PITCHROOM_ENVIRONMENT_ID` | UUID for the provisioned environment, matching its independently initialized database identity row |
| `PITCHROOM_DATABASE_ROLE` | Expected runtime SQL role, matching `current_user` and the identity row |
| `PITCHROOM_TARGET_RECEIPT_SHA` | SHA-256 of the operator-accepted PIT-32 target receipt; binds the environment to the separately verified cloud account/project/branch |
| `PITCHROOM_PROVIDER` | openai or deepseek, matching the allowed endpoint |
| `OPENAI_BASE_URL` | Explicitly `https://api.openai.com/v1`, or the supported DeepSeek base `https://api.deepseek.com` / `/v1`; no userinfo, query or fragment. No provider fallback. |
| `OPENAI_API_KEY`, `OPENAI_MODEL` | Nonempty key and explicit model identifier. Validation does not call the provider or verify model availability. |
| `PITCHROOM_LIVE_TRANSFER_ACK` | authorized |
| `PITCHROOM_TRANSFER_APPROVAL_ID` | Nonempty approval reference; actual source-bound approval verification remains a separate gate. |
| `PITCHROOM_BUDGET_ID` | Nonempty budget reference; durable reservations and spend enforcement remain separate gates. |

Do not supply invented approval or budget IDs to make a trial appear ready.
These references must eventually resolve to accepted artifacts under PIT-55/39.
They are currently declarations, and deployed readiness remains refused.

Deployed URLs omit no target fields. Encode reserved user/password characters
using URL serialization, but use the database's literal name. Multi-host, IPv6,
encoded database names and noncanonical URLs are refused because the installed
driver can interpret them differently from the declaration parser. Local modes
retain their existing URL compatibility; they do not attest a deployed target.

Local live mode retains the existing OpenAI default endpoint. A configured
DeepSeek endpoint is recognized locally; an explicitly contradictory provider is
refused. Custom local endpoints may use HTTPS or loopback HTTP for synthetic
testing. This local compatibility does not authorize their use in deployment.

### Startup and variable sources

Use the installed Node 24 runtime (minimum 24.10.0, matching the CI family) and
pnpm 9.6.0 with the existing lockfile. The CLI imports a TypeScript-only parser
using Node's native type stripping; Node 20 is not supported. No dependency or
installation is added by this increment.

- `pnpm env:check`: validate Web declarations.
- `pnpm env:check --worker`: validate worker declarations.
- `node scripts/check-env.mjs --worker --live`: include the worker's legacy live flag when checking it.
- `pnpm start`: run the production configuration preflight, then `next start`.
  The server uses the supplied `PORT`; build first with `pnpm build`.
- `pnpm worker:clarify --live`: validate, then run the persistent worker.

The checker reads `apps/web/.env.local` only for local development/test. Existing
process variables win, including an empty value that must fail validation.
Local env files cannot select a deployed environment. `--production`,
`NODE_ENV=production`, and an explicit deployed environment disable this file
loading. Worker configuration is always supplied explicitly; it never loads an
env file. Unknown command options fail.

Next.js can itself load env files. Do not package local env files into a deployed
image or build context. Inject deployment variables and credentials through the
service environment, not a copied development file. The request guards still
validate configuration if an operator bypasses the supported start command.

Builds need no live credentials. For an isolated local production fixture,
explicitly set `PITCHROOM_DEPLOYMENT_ENV=local` and `PITCHROOM_RUNTIME=fixture`.
This is a local test environment and must not be labelled trial or production
acceptance.

### Health and the remaining PIT-34 gate

The local health endpoint retains fixture/persistent synthetic behavior. The
legacy `checks.liveModel` field means live configuration is valid, not that a
provider request succeeded or semantic quality passed. DB errors are redacted.

For declared deployments, a bounded, read-only database transaction observes the
actual database name, role, public schema, environment identity, full ordered
Drizzle migration ledger and recent worker registrations. `targetIdentity`,
`schema` and `worker` describe these observations separately. The complete list
of migration SQL hashes and journal timestamps is compiled into the release;
missing, changed, reordered or unknown newer migrations fail. A new migration
must update the pinned list and pass its source-integrity test. The migration
ledger does not detect arbitrary manual DDL drift; use reviewed migrations and
restricted operator access.

Deployment TLS validates the certificate chain and hostname with the installed
Postgres driver. Local synthetic tests exercise real TLS handshakes. TLS and an
identity row still cannot establish cloud account/project/branch ownership:
PIT-32 must independently accept that receipt and its SHA before any release.
Copying an identity row into another database is not provisioning acceptance.
Runtime startup never inserts/updates the identity row or runs migrations.

Migration 0013 adds empty `deployment_identity` and `worker_heartbeats` tables.
For a separately authorized provisioned target, the migration operator must
initialize the singleton identity with the environment UUID, environment name,
credential-free target, actual database name, runtime role and accepted receipt
SHA. Give the Web role SELECT on both tables and the Drizzle ledger; the worker
also needs INSERT/UPDATE on heartbeats. Ordinary runtime credentials must not
write identity/ledger rows or execute DDL. Exact cloud privileges and migration
execution remain PIT-32 acceptance work, not an application startup step.

Workers validate identity and schema before runner construction and before each
claim. A random process UUID registers only after verification. Registration is
serialized with an advisory transaction lock, so two simultaneous workers cannot
both become the singleton ready instance. A separate connection refreshes every
10 seconds, including during long model work. Heartbeats expire at 30 seconds
using database time; these are initial policy values, not a measured SLA.
Missing, future, stale, stopped, incompatible or duplicate active instances fail.
Restart requires the prior instance to stop or expire. A failed heartbeat stops
new claims; it does not prove an already-running provider request was cancelled.
SIGINT/SIGTERM marks the instance stopped and closes its heartbeat connection.
SIGKILL cannot write a stop marker; readiness fails after the expiry window.
Task leases, provider timeouts and crash recovery remain PIT-36 responsibilities.

Each Web probe owns and closes one connection (connect timeout 2 seconds,
statement timeout 1.5 seconds, lock timeout 0.5 seconds). Heartbeat writes use one
reused connection. Timeout, permission or query failure returns a redacted
`DATABASE_OBSERVATION_UNAVAILABLE`; other failure codes are
`DATABASE_IDENTITY_MISMATCH`, `SCHEMA_IDENTITY_MISMATCH`, `WORKER_UNVERIFIED` and
`AUTHORIZATION_UNVERIFIED`. Public diagnostics omit database host, credentials,
identity receipt, approval IDs, budget IDs and customer content.

Overall deployment health still returns 503 `DEPLOYMENT_READINESS_UNVERIFIED`
because `authorization` remains false until PIT-39/55 implement actual approval
and budget enforcement. `checks.liveModel` still means valid declarations only.
The readiness endpoint is an operational signal; it does not itself block every
business API if a caller bypasses a deployment gate. Authentication, source-bound
permission enforcement and request admission remain separate release blockers.

PIT-34 remains open for its full original contract. This increment does not
align managed database versions, verify a real target receipt, enforce provider
spend, execute real migrations, rehearse hosted restore, deploy or merge. CI's
PostgreSQL 16.4, the local PostgreSQL 17 synthetic rehearsal and the eventual
managed service still require reconciliation under PIT-32. Independent review,
QA, exact-version CI, current-main integration and human release approval remain
required; a passing synthetic observation is not controlled-trial acceptance.
