# Pitchroom application

Fresh implementation derived from the `../pitchroom-v6/` product and design baseline.
The archived application is not an implementation dependency.

## Current slice

The first slice accepts pasted text, `.txt`, and `.md` sources and produces a
source-grounded `UnderstandingProposalV1`. Every supported claim must reference
an existing source chunk and an exact quote. A successful agent run stops at
`review_required`; it does not silently approve its own proposal.

The local browser flow uses a clearly labelled synthetic agent so the complete
state/tool/review loop can be exercised without transferring material to an
external model. `VercelAiUnderstandingRunner` is the production-shaped AI SDK
adapter; creating a live runner fails closed unless both an API key and a pinned
model are supplied. The `live` web runtime additionally requires
`PITCHROOM_LIVE_TRANSFER_ACK=authorized`. No live model result is claimed yet.

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
bounded run trace, exact-quote evidence, user correction with attribution,
question answers, version history, stale-revision rejection, cancellation/retry,
and explicit acceptance. Sources expand to stable chunk IDs, offsets, and text.

To run the same deterministic agent through PostgreSQL-backed state:

```sh
PITCHROOM_RUNTIME=postgres-fake \
DATABASE_URL=postgres://pitchroom:pitchroom@127.0.0.1:54329/pitchroom \
pnpm --filter @pitchroom/web exec next dev -H 127.0.0.1 -p 3001
```

`pnpm qa:persistent-http` verifies the complete persistent HTTP flow on port
3001. After restarting the server, `pnpm qa:persistent-readback` verifies that
the accepted state and version history survived the process.

## Verification

```sh
pnpm check
pnpm test:server
pnpm eval:offline
pnpm harness:case -- supported-growth
pnpm harness:replay -- eval-supported-growth
```

- `pnpm check`: type checks all packages, runs deterministic tests, and builds
  the production Next.js application.
- `pnpm test:server`: migrates/uses the local PostgreSQL contract and verifies
  project isolation, idempotency, transactional version creation, stale-write
  rejection, user-input attribution, and current-version acceptance.
- `pnpm eval:offline`: validates the 15-case taxonomy, rubric gate, and seeded
  grader failures. It is not evidence of live-model quality.
- `pnpm harness:case`: runs one scripted fake-model case through the real bounded
  tool/controller path and writes a redacted bundle under `.artifacts/agent-runs/`.
- `pnpm harness:replay`: verifies event ordering and reconstructs the terminal
  phase without calling a model.

After separate authorization, the synthetic-only live eval gates are:

```sh
PITCHROOM_LIVE_EVAL_ACK=synthetic-only OPENAI_API_KEY=... OPENAI_MODEL=... pnpm eval:live:smoke
PITCHROOM_LIVE_EVAL_ACK=synthetic-only OPENAI_API_KEY=... OPENAI_MODEL=... pnpm eval:live:all
```

Smoke selects five categories before the full model set. A critical failure
stops the batch, and each batch keeps its own artifacts.

Live model evaluation, recorded browser QA, deployment, and real-user
acceptance remain separate authorization and evidence gates.
