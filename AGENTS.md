# Pitchroom agent entry point — fresh start

## Read before acting

1. Read `SOURCE_OF_TRUTH.md` for authority and routing.
2. Read `pitchroom-v6/README.md`, then the relevant section entries in `pitchroom-v6/manifest.json` and the referenced PRD/design/evidence.
3. For verification, read `pitchroom-v6/HARNESS.md`. Read original evidence only as needed to substantiate a claim.

The user explicitly approved starting over from v6 on 2026-10-11. The former application, PRD, Layout A, architecture and tests are archived and **do not constrain the new implementation**. Do not scan or resurrect `archive/` by default. No new application or technology stack has been implemented/selected by the reorganization. The original agent instructions are preserved with the archived project, not current instructions.

## Route by requested outcome

- Questions/status/reviews authorize inspection, not implementation.
- Use available skills when applicable, within the user's requested scope. Report-only testing must not silently become a repair/commit loop.
- Browser QA uses isolated synthetic state, not a user's live project. During black-box QA, do not inspect application source.
- Use `autoplan` only when requested or a material new plan needs review; do not rerun discovery for an already-approved scoped repair.
- Implementation requires a scoped request. The start-over/cleanup approval does not authorize building the whole product.
- New installations/tools, paid services, real AI calls, external data transfer, commits/PRs, shipping and deployment require their own authorization. Do not install just because setup commands exist.

## Preserve and verify

- Most prior work was untracked. HEAD is not a complete backup. Never reset, clean, blanket-commit or stash this workspace.
- Keep `pitchroom-v6/prototype/index.html`, reference screenshots, raw results/traces and recorded scripts unchanged unless their specific change is authorized. Evidence from a prior version is not a fresh pass.
- Preserve missing-information tolerance, explicit choice/apply boundaries, original-framing option, source access, manual edits, history and undo as specified in v6. These product requirements do not mandate reuse of the old implementation.
- Do not read private project databases, secrets, session state or personal reflections by default. Archived records and `.trash/` are not routine search targets.
- Compare designs to v6, not the historical root DESIGN.md. New app tests must be derived from current requirements; old tests are historical evidence only.

## Current verification (baseline only)

```sh
cd pitchroom-v6
bun run check
bun run check:workspace
bun run typecheck
```

The existing local verification dependencies live under `pitchroom-v6/node_modules/`. These checks are not application tests or browser regressions. No root app build/dev command exists after cleanup. Browser capture requires separate capacity and a compatible existing Chromium; do not download one silently.

## Finite verification and evidence safety

- All raw QA evidence stays local and unuploaded. The approved total cap remains **320,000,000 bytes**; relocation does not reset it.
- Count the package roots and every historical/current workspace evidence root listed in `pitchroom-v6/manifest.json`. After the user-approved 2026-10-11 pruning of four archived R2 runs, counted usage is 216,039,424 bytes, leaving 103,960,576 bytes under the cap. No new recording without explicit authorization; available capacity alone is not authorization.
- Do not delete runs, weaken assertions, change references, suppress errors or count skipped/missing checks as success.
- Two unsuccessful evidence-led repairs of one defect: stop before a third. Do not rerun an unchanged passing check without a reason.
- Engineering verification, recorded prototype evidence and human acceptance are distinct. Report only what was actually checked; do not infer real AI quality or customer demand.
- When a necessary decision is missing, ask once and stop; automatic continuation is not approval. No automatic goals, monitoring or repair loops.
