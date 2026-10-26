# Pitchroom v6: product and design baseline

Updated: 2026-10-11. Scope: the standalone black/orange mockup and sole product/design starting point for a fresh implementation. The new app is not built yet.

Pitchroom helps consultants turn messy client material into a positioning decision and a presentation they can discuss with the client. The key result is not more slides: it is a clearer choice, made visible in the work.

**Status:** the user provisionally accepted the v6 interaction direction (“差不多先到这样没什么问题”), then explicitly approved starting over from this package and archiving the old engineering project. This is not production G3 acceptance, AI-quality validation, or evidence of demand. Previous PRD/design documents and HTML versions remain intact in the local archive, but no longer govern the new build.

## Read by task

| Need | Read |
|---|---|
| Product scope and acceptance criteria | [PRD](PRD.md) |
| Layout, interaction rules and reasons | [Design](DESIGN.md) |
| See each section and inspect recorded evidence | [Screenshot gallery](EVIDENCE.md) |
| Retrieve one section, check integrity, or capture evidence | [How to use this baseline](HARNESS.md) |
| Machine-readable paths, requirements, checks and hashes | [Manifest](manifest.json) |

For a section-scoped task, load this entry, then only that section's PRD/design anchors and evidence IDs from the manifest. Do not load every trace or the entire historical conversation by default.

## Four revisitable destinations

```text
Materials <--> Clarify <--> Positioning --> Deck
   ^              ^            ^           |
   | topic file   | context    | revise    |
   +--------------+------------+-----------+
```

| ID | User's question | Product | Design | Screenshot |
|---|---|---|---|---|
| MAT | What material do I have? | [Requirements](PRD.md#materials) | [Layout](DESIGN.md#materials) | [Materials](EVIDENCE.md#materials) |
| CLR | What is unclear, and what can I add? | [Requirements](PRD.md#clarify) | [Layout](DESIGN.md#clarify) | [Clarify](EVIDENCE.md#clarify) |
| POS | Which story should lead? | [Requirements](PRD.md#positioning) | [Layout](DESIGN.md#positioning) | [Positioning](EVIDENCE.md#positioning) |
| DCK | Can I take this into a client discussion? | [Requirements](PRD.md#deck) | [Layout](DESIGN.md#deck) | [Deck](EVIDENCE.md#deck) |

## Try the loop in three steps

1. Open [the unchanged v6 HTML](prototype/index.html) in a browser. No server, installation, API key or network is required. Click **Open sample project**.
2. In **Clarify**, try an answer and save it to see Before/Now. Use **Materials** to inspect the files, then **Back to Clarify** to resume. Unknowns can stay open.
3. Open **Positioning**, choose **Taste first**, **Preview the impact**, then **Use this change**. Click **Use direction & create deck**; inspect five pages and edit one as a new draft.

What you built: a fictional discussion draft from an explicit judgment. Sample understanding and transformations are prewritten. Files are names only, not read or uploaded; user text is carried literally. State lasts only until reload. See [all boundaries](PRD.md#boundaries).

## Authority and version boundaries

| Target | Governing documents | Do not infer |
|---|---|---|
| This v6 baseline and a future fresh implementation | This package, the linked HTML, and explicit later user decisions | That cleanup has implemented or authorized the entire new app |
| Archived Bun/TypeScript application | Historical references only under `../archive/pre-v6/` | That its Layout A, eight-slide flow, code or tests constrain the rebuild |
| Execution and evidence safety | Self-contained safeguards in [Harness](HARNESS.md); repository work also follows `../AGENTS.md` | Automatic repair, publication, storage deletion or extra capacity |

The latest user-authored PRD v0.4 is consolidated here by section. Document label `0.4-v6` means that consolidation, not a released product version. Target release remains `0.1`.

Before a fresh implementation, resolve the [open decisions](PRD.md#open-decisions). This mockup has five pages and tab-local state; neither settles the new app's architecture, storage or production deck length. The archived eight-slide app is no longer an integration target.

All current v6 material lives in this folder. Screenshots are actual files in `screenshots/`, not links to another evidence directory. Traces, immutable recorded results and earlier v6 attempts live in `evidence/`; runnable harness utilities and archived test sources live in `harness/`. No symlinks or external image dependencies are needed to read the package. Evidence remains local and gitignored; it was moved, not duplicated or uploaded.

```text
pitchroom-v6/
  README.md, PRD.md, DESIGN.md, EVIDENCE.md, HARNESS.md
  manifest.json          # package-relative machine index
  prototype/index.html   # unchanged interactive v6
  screenshots/           # nine selected section/state screenshots
  evidence/              # traces, results, earlier attempts, relocation record
  harness/               # integrity check, capture utility, recorded test sources
```

The whole folder can be moved for local reading. Existing verification dependencies were relocated into `node_modules/`, described by `package.json` and a trimmed lockfile; nothing was installed. They support the baseline harness only, not a preselected app stack. Publishing or transferring raw evidence needs separate authorization.
