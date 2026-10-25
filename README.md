# Pitchroom — start over from v6

> Current application and verification: [pitchroom-app](pitchroom-app/README.md) · [2026-10-25 live full-flow audit](pitchroom-app/docs/verification/2026-10-25-live-full-flow.md). The cleanup description below is historical; a local implementation now exists.


The user approved a fresh implementation on **2026-10-11**. The previous application is archived, not the foundation or acceptance contract for the next build. No new application has been implemented by this cleanup.

## Start here

- [Current product/design package](pitchroom-v6/README.md): PRD, design, section screenshots, interactive HTML and evidence.
- [Open the offline prototype](pitchroom-v6/prototype/index.html): no server, installation or API key needed. Open it in a browser; this is a simulated prototype, not real AI or persistence.
- [Knowledge navigation](SOURCE_OF_TRUTH.md): where to read, where to put new work and which version governs.

The new starting point is **Materials → Clarify → Positioning → Deck**. The old white/green layout, eight-slide contract, app architecture and tests are not requirements for a rebuild. Choose implementation architecture and production acceptance criteria explicitly from the v6 requirements.

## Repository layout

```text
pitchroom-v6/     Current baseline, screenshots, local evidence and scoped harness
archive/         Previous engineering project and history; opt-in reading only
.trash/          Recoverable legacy dependencies/build output; not active code
AGENTS.md        Agent scope and safety rules
SOURCE_OF_TRUTH.md  Knowledge navigation
```

Git history and private local state remain untouched. Archived material and raw evidence are local-only and ignored by Git; a Git-only copy is not a complete backup.

## Existing baseline checks

The already-installed verification dependencies were moved into `pitchroom-v6/node_modules/`; no packages were installed. These tools verify the baseline, not a new app.

```sh
cd pitchroom-v6
bun run check
bun run check:workspace
bun run typecheck
```

The package check can pass while the workspace check reports **BLOCKED_BUDGET**: historical screenshot folders omitted by the old counter are now included. Existing evidence exceeds the approved 320 MB cap. Do not capture new evidence until the user approves a capacity decision; do not delete old runs to get green.

For historical restoration only, see [the archive guide](archive/README.md). Do not run old setup, tests or deployment instructions by default.
