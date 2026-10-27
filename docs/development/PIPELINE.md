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

The source job scans every outgoing commit, not just the final tree. The app job runs types, unit tests, offline eval, database-target guard, build, every discovered persistence integration suite serially against an ephemeral local PostgreSQL service, and synthetic browser checks. Browser uses runner-preinstalled Chrome; missing browser fails, with no fallback download. Screenshots, trace and video are off. No raw evidence/log artifact upload exists. Child stdout/stderr stays in runner temporary files; only stage/exit summaries appear in Actions. The first run at d903355 failed the existing complete-table test fixture (missing topicMaterials), and PR gate correctly failed. The test-only correction adds the existing required table and its missing-table negative assertion; no production behavior or assertion is removed. Raw runner files expire with the runner; they are not durable acceptance evidence. Retain commit/run/check IDs and summary conclusions; deeper failure diagnosis must run locally without uploading original QA.

`PR gate` fails if any required job fails, is skipped or is cancelled. It binds to the PR head. PR checks alone do not prove compatibility with a later main: merge one PR at a time, recheck remaining PRs after base changes and require main-push checks before completing the issue. Until this workflow is integrated into a PR's base or explicitly included in its branch, old PRs may show no CI; absence is a gap.

GitHub-enforced branch protection is not available under the current private-repository plan. The local push guard and human merge review remain necessary and bypassable by the owner. This batch does not purchase an upgrade or claim server-enforced protection.

## Migration and recovery

Follow migration-plan.json: baseline → push guard → this foundation → feature PR after its owner finishes latest-head acceptance. Preserve original work, local failure evidence and runtime records. Never reset/clean/stash, force-push or blanket-import old history. If CI or migration fails, retain the failing commit/run, keep dispatch paused and report the exact gap. No automatic retries or repair loop.

The old controller/configurations remain preserved and disabled. Do not invoke them for new GitHub-history tasks. Later batches must connect Multica PR events, migrate the controller, validate serial unattended delivery, then enable two lanes. No automatic merge, parallel dispatch, deployment, real product-model call or recording is enabled by this batch.

## Domain-free polling and single-lane runtime (2026-10-27)

This section supersedes migration-time execution descriptions above. `github_sync.py --apply` reads all PR/issue pages and the exact-head `pr-ci.yml` workflow, then updates only dedicated `github_*` metadata. Existing developer/review/QA fields are preserved. Missing old CI stays missing. No comments, Agent mentions, GitHub App, domain, public callback or native PR-card claim. Unchanged data refreshes observation time only. Failed/partial reads or a changing PR head stop scheduling and mark prior observations unavailable when reachable.

`serial.py tick --apply` is the new canonical dispatcher. The old original-workspace controllers/configs remain disabled and their state is not imported. It reuses their tested artifact/contract primitives but publishes only declared source from integrated main; native runtime commits/managed AGENTS are excluded. Roles submit and exit; a later tick alone performs the next transition. One lane covers development, CI wait, review, QA and merge wait. No comments are used for handoffs. Metadata does not itself authorize a transition: the same tick uses its fresh in-memory snapshot, immutable artifact and terminal runtime identity.

Activation requires `serial.py activate --receipt LOCAL.json` after an approved merge: clean integrated main, passing main CI, completed independent Reviewer/QA reports on the same integrated source, controller-file identity, one-lane config and disabled legacy controls. The receipt names `issue`, local `reviewer_report`/`qa_report` paths, and authority `direct_human_domain_free_serial_2026-10-27`. A fingerprint in `.state/pipeline/activation.json` invalidates activation when controller/config/policy bytes change. This is an engineering safety gate, not an OS permission boundary. No source config alone starts anything. Keep the existing Autopilot paused until activation and a real dry tick pass; then point its existing Dispatcher at the canonical command and enable that same schedule, never create a second scheduler.

[Role protocol](../../tooling/pipeline/ROLE_GUIDE.md) preserves complete frozen criteria and independent controller-executed proof. QA never merges. Completion needs the actual human merge, verified exact-head squash integration and exact merge-commit push CI; a moved main holds for explicit integration verification. Existing decision holds, legacy signoffs, protected local evidence and no-product-model/install/deploy boundaries remain. No parallel rollout is enabled.

Poll metadata is not the native Multica PR sidebar. Current status remains read-only; polling failure is unavailable, never success. Operator rollback: pause the existing Autopilot first, then retain but deactivate the local activation receipt; do not clear uncertain ledgers or delete evidence. Disable does not cancel active runs. Missing/ambiguous output is reconciled against actual runs/remote refs before any retry.

Review repair: a failed polling batch invalidates both prior-known and newly touched snapshots; issue-list outages retain a local unavailable health marker. Observation deadlines include publication time and are checked again at role starts/completion. Forward handoffs require an active PR still targeting main. The next local stage is durably published before the remote status can enqueue its worker; uncertain acknowledgements remain held rather than replayed.

### Automatic capacity ownership

The single lane counts controller-owned artifacts through CI/merge waits, active pipeline-role assignments and every actual nonterminal project issue runtime. Idle human-owned legacy issue statuses do not consume the automatic lane, and remain untouched. Unknown/unavailable runtime history holds. This isolates automatic delivery capacity from manual product work; it neither adopts old tasks nor enables two automated lanes. The read-only status tools have four exact publication paths under tooling/pipeline-status; controller/governance edits remain operator-reviewed bootstrap work.


### PR merge method

Shaun requires **Squash and merge** for every future PR. After explicit approval of the immutable head, use `gh pr merge N --squash --match-head-commit APPROVED_SHA`. Do not use merge commits or rebase merge, delete task branches, or rewrite earlier merges. Approval, independent review/QA and current-head CI still apply.

Completion verifies that the actual single-parent squash commit is directly above the independently captured pre-merge main and has exactly the tree produced by merging the approved source head into its actual integration parent. Conflicts, extra/omitted changes, unknown mappings or missing actual squash-commit CI hold. Save this mapping with the lane; dependent tasks require its verified integration commit in their base. Historical accepted commits retain their original ancestry checks. Bootstrap activation can resolve an exact reviewed head through its unique merged PR and the same squash proof; controller-file identity checks remain mandatory.


Before a controlled PR merge, the human operator records the approved head with canonical `serial.py approve-merge PIT-N --approved-head SHA` after human exact-head approval. This captures live pre-merge main and requires its CI, then performs no merge itself. Use the approved-head squash command immediately afterwards. A changed base requires explicit reconciliation; never infer the recorded base from the completed merge. Without the independent pre-merge binding, even a rebase merge can have the same final tree, so completion holds. For operator bootstrap PRs, capture the pre-merge main in the local activation receipt as `reviewed_integration_base` before merging; the same proof applies. Do not automatically re-sign activation after controller changes.
