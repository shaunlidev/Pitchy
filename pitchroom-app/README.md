# Pitchroom application

Fresh implementation derived from the `../pitchroom-v6/` product and design baseline.
The archived application is not an implementation dependency.

## Current local loop

The implemented V6 loop is `Materials -> Clarify -> Positioning -> Deck` for one
local project. It accepts pasted text, `.txt`, and `.md` sources, produces a
source-grounded understanding, stops for explicit acceptance, previews
source-grounded positioning directions, requires an explicit Apply, and creates
a fixed five-page discussion deck only after the user asks for it.

Deck pages are Positioning, Shift, Rationale, Evidence, and Open questions.
Page edits create a new draft; prior drafts remain read-only. New material or a
new positioning choice marks the saved deck stale rather than overwriting it.
Browser Print / Save PDF is the only export in the local scope.

The local browser flow uses a clearly labelled synthetic agent so the complete
state/tool/review loop can be exercised without transferring material to an
external model. The live Understanding, Positioning, and Deck adapters fail
closed unless an API key and pinned model are supplied. An OpenAI-compatible
provider can also be selected with `OPENAI_BASE_URL`. The `live` web runtime
additionally requires `PITCHROOM_LIVE_TRANSFER_ACK=authorized`. Positioning and
Deck adapters have mocked contract tests, but no live model result is claimed.

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
pnpm test:server
pnpm eval:offline
pnpm qa:e2e
pnpm harness:case -- supported-growth
pnpm harness:replay -- eval-supported-growth
```

- `pnpm check`: type checks all packages, runs deterministic tests, and builds
  the production Next.js application.
- `pnpm test:server`: migrates/uses the local PostgreSQL contract without
  truncating existing projects, and verifies
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
