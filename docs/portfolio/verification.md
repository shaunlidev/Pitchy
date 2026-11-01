# Portfolio verification record

Date: 1 November 2026. Application baseline: `120b82e01e1cc948f6758826c10725f889d4e3c6`.

This record separates completed checks from failed observation scripts and work that was not run. There is no whole-product PASS.

## Scope

The check uses an independent task worktree, existing Node.js 24.19.0, installed application dependencies, existing Google Chrome, and a localhost-only fixture server. Internal workspace dependency links point at the task checkout. No environment files, database configuration, or provider credentials are copied into it.

The black-box phase inspects the interface and HTTP responses without reading application source. Browser requests outside localhost are blocked. No screenshot, video, or trace is recorded.

## Actual checks

| Check | Result |
|---|---|
| Fixture health and empty synthetic workspace | Passed |
| Brief saved through the interface | Passed |
| Understanding stops for review | Passed |
| Explicit synthetic acceptance and positioning recommendation | Passed |
| Preview does not apply a direction | Passed |
| Synthetic operator selects an alternative to the recommendation | Passed |
| Story preview and dismissal do not adopt | Passed |
| Explicit adoption followed by exact Deck V2 transfer | Passed for three synthetic Story blocks |
| Manual page edit creates Draft 2 and retains Draft 1 | Passed |
| Prior draft opens through the interface | Passed |
| Unsupported upload preserves saved brief, sources, and deck history | Passed |
| Return from upload error to current draft | Passed |
| Reload retains the selected current draft in the same process | Passed |
| Documentation links and evidence references | Passed: 31 Markdown links, six source hashes, three historical report hashes, and two failed-script hashes |

The browser scripts completed 14 named checks. Six additional offline controls exercised the real response contract and domain validator: a valid Story passed, a 47-word generated body failed each boundary, an undefined basis reference failed, exact saved 47-word human wording passed, and changed wording could not retain an exact-human label. No provider request was involved.

## Observation errors retained

The first browser probes saw the loading state. A main element alone did not prove the application was ready. A subsequent probe waited for Save brief while the empty editor exposed Save cleared brief. The walkthrough now waits for the input, enters text, and then uses the actual save action. These were observation errors, not established product defects.

The first browser-library import failed in the tool runtime. A CommonJS import resolved that issue. Browser launch in that tool then failed with process permission errors. Running the existing Chrome through the authorized local process tool succeeded. No application repair or dependency installation followed from those environment failures.

One edit script correctly created Draft 2 and opened Draft 1, then failed because it expected reload to discard the selected historical draft. The interface instead retained Draft 1 read-only. A separate observer confirmed the Draft 1 heading after reload but failed to match a read-only message with an exact text locator across split nodes. Its returned body contained the message and the Return to current draft button. Both failed scripts remain local and are identified by hash in the evidence index. No third repair of that observer was attempted. Historical-position recovery is therefore recorded as a body observation with incomplete automated assertion, not an additional passing check.

The independent upload and current-draft refresh script passed. That script did not repeat the failing historical-position assertions.

## Reproduction references

The browser scripts and contract probe remain local QA under the original workspace's `tooling/planning/portfolio-closeout-20261101/`. They are excluded from this source-only branch. `browser-stage.cjs`, `browser-story.cjs`, `browser-edit.cjs`, `browser-edit-recovery.cjs`, and `browser-upload.cjs` ran with the existing Node 24 executable. The last two edit scripts have the outcomes described above. `story-contract-probe.mts` ran with the existing `tsx` loader against the owned synthetic fixture and current source contracts. The [demo guide](demo.md) provides the manual walkthrough without requiring those local scripts.

## Not performed

- Real-model generation, semantic scoring of a new provider response, or first-attempt reliability measurement.
- PIT-17 continuation or repair of its stopped verification run.
- PostgreSQL, persistent worker, or process-restart persistence validation.
- Target-consultant observation, independent Apply, or external downstream use.
- Shaun's spoken explanation or independent coding exercise.
- Full V6 acceptance, production readiness, PDF fidelity, native assistive-technology validation, or a full application test suite rerun.
- Installation, recording, merge, deployment, or public publication.

Historical reports are listed separately in the [evidence index](evidence-index.json). They are not included as raw files in this branch.
