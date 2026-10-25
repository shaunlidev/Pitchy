# Pitchroom v6 screenshot and evidence index

Updated: 2026-10-11. All images use fictional local material. None were uploaded.

[Entry](README.md) · [PRD](PRD.md) · [Design](DESIGN.md) · [Verification instructions](HARNESS.md) · [Machine index](manifest.json)

## What this evidence establishes

The unchanged v6 HTML and its targeted test match the passing `2026-10-11-mockup-v6-02` result. Existing screenshots are reused, not presented as a fresh regression run. A separate documentation capture adds Positioning, comparison and Deck views. The manifest records exact paths, SHA-256 hashes, image dimensions, run ownership and check mappings.

The user provisionally accepted the prototype direction on 2026-10-11 and subsequently approved it as the starting point for a fresh build. This is not production acceptance; the old application's G3 is now historical, not a gate inherited by the new app.

<a id="materials"></a>
## MAT: Materials

`MAT-LIBRARY` · 1280 × 800 viewport. The existing-file view, including the explicit return to Clarify.

![Materials: independent file inventory and Back to Clarify](screenshots/materials-desktop.png)

Other states: [fresh intake](screenshots/materials-entry.png) (`MAT-ENTRY`); [mobile inventory](screenshots/materials-mobile.png) (`MAT-MOBILE`, 375 × 812). Mobile is a viewport capture, not the full scrollable inventory.

<a id="clarify"></a>
## CLR: Clarify

`CLR-QUESTION` · 1280 × 800 viewport. Compact topic map, current understanding, one question and optional scoped upload.

![Clarify: topic coverage next to one current question](screenshots/clarify-desktop.png)

Other states: [saved Before/Now feedback](screenshots/clarify-feedback.png) (`CLR-FEEDBACK`); [mobile question](screenshots/clarify-mobile.png) (`CLR-MOBILE`, 375 × 812).

The latter two include literal `<script>keep literal</script>` test text to verify safe text preservation. It is synthetic test input, not product copy or an executed script. The mobile screenshot does not show the whole page or establish that Save fits above the fold.

<a id="positioning"></a>
## POS: Positioning

`POS-WORKING` · 1280 × 800 viewport, full-page image 1280 × 1076. Taste-first judgment applied; the paper, From/To comparison and next action are visible.

![Positioning: working direction, before/after and explicit generation](screenshots/positioning-desktop.png)

[Three-direction comparison](screenshots/positioning-directions.png) (`POS-COMPARE`) shows choices, trade-offs, source access and original-framing option. This is a full-page capture with a viewport-centered modal, not proof that the page fits in one screen.

<a id="deck"></a>
## DCK: Deck

`DCK-FIRST` · 1280 × 800 viewport, full-page image 1280 × 961. The selected direction becomes a separately versioned five-page discussion draft.

![Deck: same paper treatment, page navigation and editing controls](screenshots/deck-desktop.png)

## Recorded runs

| Run | Purpose | Result and scope |
|---|---|---|
| `2026-10-11-mockup-v6-02` | Reused targeted mockup suite | Passed; eight recorded check groups, zero page errors/external requests. Includes desktop/mobile navigation, input continuity, optional gaps, preview/apply/undo, manual editing and read-only history. |
| `2026-10-11-mockup-v6-docs-02` | New documentation screenshots | Passed; Positioning, comparison and Deck, zero page errors/external requests. Not another full regression. |
| `2026-10-11-mockup-v6-docs-01` | Earlier viewport-only capture | Retained but not selected as the documentation baseline: Positioning was scrolled below the header and Deck navigation was partly outside the viewport. The capture was corrected, not the UI. |

Selected results and traces:

- [Targeted result](evidence/runs/2026-10-11-mockup-v6-02/result.json) / [interaction trace](evidence/runs/2026-10-11-mockup-v6-02/materials-workspace.trace.zip).
- [Documentation result](evidence/runs/2026-10-11-mockup-v6-docs-02/result.json) / [capture trace](evidence/runs/2026-10-11-mockup-v6-docs-02/documentation-capture.trace.zip).
- Earlier implementation failure and repair: [archived v6 notes](evidence/v6-notes.md). Its old paths are historical; [the evidence map](evidence/README.md) locates the unchanged files now. Old failures remain available; no assertions were weakened.

## Coverage limits

Source/test identity, recorded results, PNG decoding and ZIP/event readability are checked by the package validator. `--workspace` additionally checks the original repository/dependency references. Screenshots were opened for visual inspection. This is not pixel-diff certification, exhaustive accessibility QA, real native zoom, print/PDF fidelity, live AI evaluation, production regression, or proof of client reuse/payment. Positioning and Deck do not have dedicated mobile screenshots in this package.

The earlier v6 result records source and test hashes, not a complete historical browser/dependency fingerprint. It supports the bounded recorded interaction claims, not full environment reproducibility. The document validator must not promote it into a production-ready release result.

## Local storage and portability

User-approved cap: **320,000,000 bytes** across this UI effort. The user explicitly approved raising the prior 300 MB cap for local v5 evidence; v6 retained that cap. Documentation captures each reserved 2,000,000 bytes before starting. Total after both captures: **318,234,624 bytes**, before subsequent small documentation-validation output. No old evidence was deleted, and no evidence is duplicated outside the evidence directory.

All nine selected images are now in this package's `screenshots/` folder. Recorded results and traces are in `evidence/`; both remain gitignored. The full folder is self-contained for reading, but a Git-only handoff still omits raw evidence. The validator reports missing files rather than passing them.

The relocation preserved the HTML, every screenshot, trace, recorded result and archived test-source bytes. Original record paths remain unchanged as historical provenance; `manifest.json` uses the package-relative paths. See [relocation inventory](evidence/relocation.json). The subsequent start-over archive moved old workspace evidence under `../archive/pre-v6/` without deleting it.

**Accounting correction and pruning (2026-10-11):** the earlier total above omitted the historical `test-results/` and `docs/designs/assets/redesign-review/` screenshots. The corrected total was approximately **322 MB**, above the unchanged **320 MB** cap. The user then approved automatic removal of old evidence to retain about 100 MB of headroom. Four archived 2026-09-26 R2 run directories (103,464 KiB) were moved intact to `.trash/evidence-pruned-2026-10-11/`, where they remain recoverable and are excluded from the evidence budget. The verified counted usage is now **216,039,424 bytes**, leaving **103,960,576 bytes** under the cap. Available capacity does not itself authorize a new capture. Exact current allocation is reported by `bun harness/check.ts --workspace`.
