# How to retrieve and verify the Pitchroom v6 package

Everything needed to read this version, see its images and open the mockup lives in this folder.

[Entry](README.md) · [Requirements](PRD.md) · [Design](DESIGN.md) · [Evidence](EVIDENCE.md) · [Manifest](manifest.json)

## Prerequisites and safety

Reading the documents, screenshots and `prototype/index.html` needs no server or installation. Running the utilities needs Bun 1.3.4 / Playwright 1.56.1 and `unzip`. The already-installed verification dependencies were moved into this package's `node_modules/`; package/lock files describe only that runtime. Nothing was downloaded. A Git-only copy excludes installed dependencies and raw evidence; do not silently install missing tools.

Keep all raw evidence local. No uploads, publication, real client data, real AI calls, commits, deployment or browser installation are authorized by these instructions. Do not use a user's live application as a test target. Repository AGENTS.md governs current execution; the former application's SOP is archived history, not a new-app contract.

The user-approved total evidence cap is **320,000,000 bytes**. Count this package's `evidence/`, `screenshots/` and `harness/recorded/`, plus every workspace root listed in the manifest. The corrected counter includes `../archive/pre-v6/artifacts/`, `../archive/pre-v6/test-results/` and `../archive/pre-v6/docs/designs/assets/redesign-review/`, and any newly created root-level evidence directories. After the user-approved 2026-10-11 pruning, verified usage is **216,039,424 bytes**, leaving **103,960,576 bytes**. Relocation does not reset the budget, and available capacity does not authorize a capture by itself.

## 1. Retrieve one section

`manifest.json` has `schemaVersion: 2` and `pathBase: "package"`. Current paths are relative to this folder, not the repository root. `recordedPath` values preserve historical locations only. Historical dependency references resolve through the workspace archive inventory; those files are not requirements or dependencies of the fresh app.

From this folder:

```sh
bun -e 'const m = await Bun.file("manifest.json").json(); console.log(JSON.stringify(m.sections.find(s => s.id === "CLR"), null, 2));'
```

Expected result: Clarify's PRD/design anchors, requirement IDs, screenshot IDs, source symbols and check IDs. Resolve IDs in `screenshots`, `checks` and `runs`; do not invent paths from labels.

Suggested agent task prefix:

```text
Target: Pitchroom standalone mockup v6, section CLR.
Read this package's README.md and manifest.json's CLR record.
Resolve current paths relative to this package directory.
Read only the referenced PRD/design sections and evidence.
Preserve literal input, optional unknowns and navigation continuity.
Do not resurrect the archived app or infer real AI from sample content.
Verify relevant evidence identity before reusing it.
Report implementation, recorded verification and human acceptance separately.
```

Use MAT, CLR, POS or DCK. Load the union for a cross-section task. V6 is now the sole new-product starting point. The old application's contracts and tests are historical and do not need to be ported or reconciled by default.

## 2. Validate without opening a browser

From this folder:

```sh
bun harness/check.ts
```

The package check verifies internal links/anchors, section mappings, all nine selected image hashes and PNG decoding, recorded run/source/test identity, trace CRC/event readability, and unchanged bytes for every immutable moved file. Three negative controls reject a changed hash, missing file and wrong-section image. It does not read old PRDs or require old HTML files outside this folder.

For the original repository's additional integrity/capacity check, run from its root:

```sh
bun pitchroom-v6/harness/check.ts --workspace
```

This also checks historical originals and original dependency fingerprints through `../archive/migration-2026-10-11.json`, repository entry links, absence of duplicate moved files and the **combined** evidence budget. Original hashes are unchanged. It reports package integrity and budget status separately, and exits nonzero when either fails. Without `--workspace`, global capacity is not assessed and cannot authorize a capture. A correct over-cap failure is not a reason to weaken the limit.

Check IDs V6-C1 through V6-C8 are groups in one previously recorded targeted run, not eight independent test cases. DOC-POS / DOC-COMPARE / DOC-DECK cover the three added views only. PASS means package integrity at the stated scope, not production regression or product acceptance.

## 3. Capture only when needed and authorized

[The current capture utility](harness/capture.ts) has been adapted to the package paths. It keeps the original assertions, fresh offline Chrome and short trace, refuses overwrite, checks the unchanged source hash and reserves 2 MB against the combined workspace budget.

From this folder, with a new run identifier:

```sh
PITCHROOM_DOCS_RUN=YYYY-MM-DD-mockup-v6-docs-NN \
PITCHROOM_CHROMIUM_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' \
bun harness/capture.ts
```

Replace the example run ID only after explicit capture authorization. Current capacity is sufficient for the utility's 2 MB reservation after the user-approved pruning, but capacity alone is not authorization. No capture was repeated for this reorganization. The relocated utility has not been browser-rerun; the original successful script is preserved byte-for-byte in [recorded/capture.ts](harness/recorded/capture.ts).

[The original targeted interaction test](harness/recorded/check-mockup-v6.ts) is also an immutable archived source. It contains historical paths and must not be run directly from this package. A future full rerun requires explicit path adaptation, the original assertions, a new evidence identity and enough approved capacity. Do not turn archived code into a claimed fresh pass.

## Evidence budget maintenance

Preview the conservative cleanup plan from this folder:

```sh
bun run evidence:maintain
```

The tool only scans `../archive/pre-v6/artifacts/`. At 280 MB it reports a warning. At 300 MB it selects enough low-risk material to return toward 280 MB: first Playwright report ZIPs whose SHA-256 exactly matches an original `trace.zip`, then archived PNG/JPEG/WebP screenshots. It never selects an original trace or anything in the current v6 manifest. If those candidates are insufficient, it stops and requests a capacity decision.

Apply the displayed plan with:

```sh
bun run evidence:maintain:apply
```

Application moves files into a timestamped `.trash/evidence-auto-pruned/` batch and writes a manifest there; it does not permanently delete them. Trash retention is manual: do not silently purge a batch after 14 days. Run `bun run check:workspace` afterward to confirm the current package and budget remain valid.

An explicitly authorized run of `harness/capture.ts` invokes this same apply mode automatically when counted usage is at least 300 MB, before reserving space for the new capture. Ordinary integrity checks remain read-only. Automatic maintenance never expands capture authorization and never makes an over-budget capture pass by deleting original traces.

## Troubleshooting and stop rules

| Condition | Response |
|---|---|
| Missing picture or trace | The folder was not copied in full, or evidence was omitted by Git. Report missing evidence; do not pass. |
| Hash mismatch | Inspect the changed input. Do not refresh expected hashes merely to get green. |
| Old path inside a result or archived source | It is immutable provenance. Use the manifest or [relocation inventory](evidence/relocation.json) for the current location. |
| Runtime/decoder unavailable | Report the exact failure; file existence is not image decoding or trace validation. |
| BLOCKED_CONTEXT / capacity not assessed | The utility cannot see the full workspace budget. Do not capture. |
| BLOCKED_BUDGET | Preserve old runs; ask for a capacity decision. Do not disable trace or delete evidence. |

Stop after one clean relevant verification. Two failed evidence-led repair attempts require a decision before a third. Do not create an automatic goal, monitor, generic repair loop, or publishable bundle by inference.
