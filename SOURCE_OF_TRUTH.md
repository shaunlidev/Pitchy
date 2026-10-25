# Pitchroom knowledge navigation

Updated 2026-10-11. This file routes tasks to original material; it does not replace the PRD or evidence.

## Find the right source

| Task | Entry | Authority / boundary |
|---|---|---|
| Inspect or run the current local app | [Application entry](pitchroom-app/README.md) and [2026-10-25 full-flow audit](pitchroom-app/docs/verification/2026-10-25-live-full-flow.md) | Actual implementation and scoped verification; v6 still governs product/design |
| Understand or build the new product | [v6 package](pitchroom-v6/README.md) | Sole current product/design starting point, per the user's start-over approval |
| Implement one section | [Machine index](pitchroom-v6/manifest.json) | Resolve MAT / CLR / POS / DCK requirements, design anchors, screenshots and checks; read only the relevant originals |
| Reuse verification evidence | [Harness instructions](pitchroom-v6/HARNESS.md) | Recorded prototype coverage only; not new app, AI quality, demand or production acceptance |
| Locate or recover historical work | [Archive guide](archive/README.md) | Opt-in only; not current requirements or executable instructions |

## Directory responsibilities

- `pitchroom-v6/`: current PRD, design, unchanged interactive HTML, screenshot references, local evidence and baseline verification tools. Put updates to these materials here.
- Repository root: concise agent/navigation files. A new app may be scaffolded here only under an explicit implementation task; no framework or app setup has been selected by cleanup.
- `archive/`: old engineering project, historical decisions and a migration inventory. Do not scan it by default. Personal records are separately stored and must not be used as product context.
- `.trash/`: recoverable old build/dependency output, not source material or an agent search target.
- `.git/`, `.gstack/`, `.pitchroom/`: preserved local history/tool/project state. Do not inspect private databases or reuse old project data without relevant authorization.

## Version and conflict rules

1. Latest explicit user decisions govern; the 2026-10-11 start-over decision makes v6 the only current baseline.
2. The archived PRD, Layout A, eight-slide flow, application architecture and old tests have **no default authority** over the rebuild. Do not port them automatically.
3. V6's interaction direction is provisionally accepted. Its fictional sample, tab-local state and five-page demo do not settle parsing, AI, storage, architecture or production deck length.
4. Preserve exact historical records. Their embedded original paths are provenance; use the archive inventory to resolve moved files, not edits to raw results.
5. If v6 and a later request conflict, identify the affected requirement before changing it. Do not silently turn mockup behavior into an unsupported production claim.

## Maintenance

New current material belongs with its v6 section. Update the manifest and relevant documents together when their contract changes; do not bulk-refresh screenshot hashes to hide failures. Historical additions belong in the archive, not the default reading path. Update this navigation only when authority, directory responsibilities or key entry points change.
