# Current Pitchroom delivery pipeline

The only current machine policy is [policy.json](../../tooling/pipeline/policy.json). This foundation batch supersedes historical two-lane/auto-completion descriptions. It does not enable unattended dispatch. Product requirements remain governed by v6.

## Inspect current state

From this engineering checkout:

```sh
python3 tooling/pipeline/status.py
python3 tooling/pipeline/status.py --live
```

The first command reports local policy only. The second reads GitHub and the authenticated Multica CLI, exposing task summaries, PR heads/checks, runtime agent availability and specific gaps. Unavailable reads exit nonzero. No command changes tasks, starts an Agent, fetches/checks out code or reads private application databases. Optional `--legacy-root PATH` checks only the two legacy dispatch switches.

## Current operation

One task lane, independent worktrees, scheduled dispatch paused. Developer commits a scoped change and opens a Draft PR; Reviewer then QA inspect its immutable head. New commits invalidate old review. This batch prepares policy and CI; it does not implement automatic role handoff or done. The canonical repository is the checkout sharing the private `shaunlidev/pitchroom` history. New ordinary work starts from integrated main. During migration only, explicit stacked bases are allowed as listed in [migration-plan.json](migration-plan.json).

A task is **ready to merge** only after all original criteria, independent review, QA and required current-head CI pass. **Engineering done** additionally requires human-approved merge and passing integration checks. Product acceptance and deployment are separate. Historical tasks are not retroactively closed or relabelled.

## CI and evidence

[PR CI](../../.github/workflows/pr-ci.yml) checks each PR head and main pushes. Actions are pinned to exact upstream commits. Node 24.10.0 and pnpm 9.6.0 are fixed; installation uses the committed frozen lockfile on an ephemeral hosted runner. No local installation is required. No production secrets are configured; checkout credentials are not persisted. Command children receive a minimal environment without provider keys or inherited database targets.

The source job scans every outgoing commit, not just the final tree. The app job runs types, unit tests, offline eval, database-target guard, build, every discovered persistence integration suite serially against an ephemeral local PostgreSQL service, and synthetic browser checks. Browser uses runner-preinstalled Chrome; missing browser fails, with no fallback download. Screenshots, trace and video are off. No raw evidence/log artifact upload exists. Child stdout/stderr stays in runner temporary files; only stage/exit summaries appear in Actions. Raw runner files expire with the runner; they are not durable acceptance evidence. Retain commit/run/check IDs and summary conclusions; deeper failure diagnosis must run locally without uploading original QA.

`PR gate` fails if any required job fails, is skipped or is cancelled. It binds to the PR head. PR checks alone do not prove compatibility with a later main: merge one PR at a time, recheck remaining PRs after base changes and require main-push checks before completing the issue. Until this workflow is integrated into a PR's base or explicitly included in its branch, old PRs may show no CI; absence is a gap.

GitHub-enforced branch protection is not available under the current private-repository plan. The local push guard and human merge review remain necessary and bypassable by the owner. This batch does not purchase an upgrade or claim server-enforced protection.

## Migration and recovery

Follow migration-plan.json: baseline → push guard → this foundation → feature PR after its owner finishes latest-head acceptance. Preserve original work, local failure evidence and runtime records. Never reset/clean/stash, force-push or blanket-import old history. If CI or migration fails, retain the failing commit/run, keep dispatch paused and report the exact gap. No automatic retries or repair loop.

The old controller/configurations remain preserved and disabled. Do not invoke them for new GitHub-history tasks. Later batches must connect Multica PR events, migrate the controller, validate serial unattended delivery, then enable two lanes. No automatic merge, parallel dispatch, deployment, real product-model call or recording is enabled by this batch.
