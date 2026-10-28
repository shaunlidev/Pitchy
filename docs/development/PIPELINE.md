# Current Pitchroom delivery pipeline

This section and the [role protocol](../../tooling/pipeline/ROLE_GUIDE.md) are the current operating instructions. Earlier migration notes are preserved below as history. Product requirements remain governed by v6.

## One configuration path

Both the controller and status command use `status.load_config`. [policy.json](../../tooling/pipeline/policy.json) owns repository/project, main baseline, one task lane, machine cap 5, merge/completion rules, observation lifetime and the safe pause default. [runtime.json](../../tooling/pipeline/runtime.json) owns local identities, the existing Autopilot ID and task routing. Repeating policy fields in runtime, unknown switches or unsupported values fails closed; changing either file never authorizes dispatch.

## Read actual state

Run from the canonical engineering checkout:

```sh
python3 tooling/pipeline/status.py
python3 tooling/pipeline/status.py --live --issue PIT-70
python3 tooling/pipeline/status.py --live
```

The offline view reads the canonical ledger and local activation/control/sync records; it cannot certify current CI, roles or completion. Live mode reads Multica and GitHub without writes or dispatch. It reports tracker status separately from controller phase, actual role/run, branch/PR/current head, same-head CI and bound role receipts, squash/merge checks, activation fingerprint, scheduler status, polling age/error, blocked reasons, next action and human decision. Manual infra PRs can be displayed from their task association, but lack of a controlled lane remains explicit and never fabricates automatic completion. No raw report/log, credential or product database is read into the output.

Missing, malformed, stale, changed-head or incomplete observations are unknown/held. A completed runtime or green CI alone is insufficient. Ready-to-merge requires current independent Reviewer and QA receipts. Engineering completion additionally requires the actual squash mapping and passing merge-commit CI. Product acceptance and deployment stay separate. Read errors exit nonzero, revoke ready/done claims and leave evidence untouched. A WAL or changing ledger is refused rather than opening writable journal state.

## Pause and activation

There is one controller and one existing schedule. Source defaults to `admission_paused`; actual scheduling remains paused until explicitly authorized. The operator may set one of these modes in the canonical checkout:

```sh
python3 tooling/pipeline/serial.py control --mode admission_paused
python3 tooling/pipeline/serial.py control --mode maintenance
```

`admission_paused` stops new task claims while allowing already authorized in-flight handoffs. `maintenance` stops sync, handoffs and dispatch; it does not cancel running Agents. A missing control record uses the safe default. An invalid or fingerprint-mismatched record holds in maintenance. `open` permits new claims only with verified activation and a separately enabled existing schedule; it is not authorized by installing this change. No command here enables two lanes. Control is operator-only, and lifting maintenance requires a valid activation.

After an approved merge, activation requires a clean current main, independent terminal Reviewer and QA on the same source, passing main-push CI, disabled legacy controls and `serial.py activate --receipt LOCAL.json`. Source/config/status changes invalidate the activation fingerprint. Activation does not resume the Autopilot or change control mode. Never create a second scheduler. `tick` without `--apply` is a non-dispatching diagnostic; inconsistent snapshots hold. Inspect results before any separately authorized real scheduling.

## Delivery, recovery and evidence

The per-task sequence is Developer → exact-head CI → independent Reviewer → independent QA → human-approved Squash → main CI → engineering completion. Every new head invalidates old role acceptance. Defects return to the original task with the existing two-repair cap; missing decisions stay explicit. Roles submit then exit; the controller alone hands off after terminal runtime evidence. See [ROLE_GUIDE.md](../../tooling/pipeline/ROLE_GUIDE.md) and [QA_SKILLS.md](QA_SKILLS.md).

Before any approved merge, read GitHub `commits/main` independently and record its actual SHA alongside the approved PR head; a PR's baseRefOid may lag main. After merging, verify the real parent and resulting tree. A mismatch preserves the old intent and requires explicit integration verification, never a rewritten pre-merge receipt. All merges need fresh exact-head human approval; no main pushes, force pushes or automatic merges.

Recovery retains original task/PR/contracts, dual native/public histories, generation and repair count. `inspect-recovery` is read-only; `confirm-recovery` can acknowledge an already observed unique run, never enqueue again. Uncertain operations do not replay. The CLI lacks server-side atomic CAS and causal operation tokens; shared locks and fresh identity snapshots do not claim stronger enforcement.

Role reports and declared probes are retained before verdict/return, including failures, with bound identity, hashes and byte accounting. An operator allocation from fresh global accounting is required under the 320000000-byte cap. Return copies/check logs/handoffs consume reservations; partial writes and deletion do not refund. Missing or unsafe paths, damaged evidence and exhausted allocation hold. No recordings, raw evidence uploads, installs, product-model calls or deployment are authorized by this pipeline. Historical lost evidence remains documented.

## Historical migration notes — not current operating instructions

The following text is preserved for provenance. Its old rollout states and commands do not override the current rules above.

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

### Reassessing a held QA report

Required omissions still block unchanged acceptance rules. Scope exclusions and future integration belong in separate report fields, not required not_run. Operator-only `serial.py retry-qa PIT-N --head SHA --reason TEXT` archives the failed lane/receipt, checks fresh exact-head CI, unchanged contract, terminal prior QA and available capacity, then enqueues one new independent QA run on identical source. It never changes an old verdict to PASS. Same-artifact retry is capped at one; uncertain enqueue is not replayed. Each role/run has its own evidence directory. Source defects still use original-task developer rework and its existing repair cap.

Transition journals include the validated preceding native run ID as well as issue/generation/phase. A held QA and its separately authorized reassessment therefore have distinct identities; repeating the same run still cannot enqueue twice. Existing confirmed/uncertain journal entries and all original receipts remain untouched.

Rework ancestry has two distinct sources: an unsubmitted Developer workspace must retain its prior native runtime commit; once a source-only artifact is frozen, Reviewer and QA must retain its prior public delivery commit. Native runtime history is intentionally excluded from published artifacts. Legacy lanes without a separate public mapping keep their original ancestry check. Missing applicable ancestry still holds; no automatic rebase or ledger rewrite is performed.

### Recovering preserved Developer source after main advances

`serial.py recover-developer PIT-N --generation G --head OLD_PUBLIC_SHA --main CURRENT_MAIN_SHA --run COMPLETED_RUN_ID --source PRESERVED_NATIVE_SHA --reason TEXT` is an operator-only, once-per-task recovery of an unsubmitted rework. It requires successful current-main and original-head CI, the unchanged original contract, a completed bound Developer runtime, its exact preserved native branch, no live/unknown runtimes and no uncertain writes. The native branch must not be checked out. Its changes since the prior delivery must contain only declared task files; main changes touching task files require explicit conflict resolution instead.

The command archives the original lane, retains both histories through local merge commits, copies only declared source into a public recovery checkpoint, and compare-and-swaps the preserved native ref. It neither pushes nor assigns a passing verdict. The next lane is saved before re-reading the complete project runtime inventory and the target revision/status/owner. A status transition names the Developer explicitly, rather than rerunning whichever role currently owns the issue, and requests one real retry at the same generation and repair count. The public CLI has no atomic revision-conditional update; controlled writers must use the shared controller lock, and observed external changes hold for reconciliation. That role must bind a fresh native workspace, run frozen checks and publish through the ordinary guarded path to the same original PR. Fresh CI, independent review and QA, human exact-head squash approval and actual main CI remain required. Local recovery merge commits are not a PR merge; final integration remains Squash. Existing failures, reports, source commits and private runtime history remain local and unchanged.

A lost Git/ref/enqueue acknowledgement retains an uncertain journal entry and forbids replay. A changed public head, native branch, main, contract, live runtime, repeated recovery or overlapping task files holds; never edit the ledger or bypass the hold to resume.

## Recovery acknowledgement and evidence retention (PIT-68 closeout)

This section supersedes the earlier recovery status-toggle description. `recover-developer` preserves its original source, contract, generation and repair gates, then journals two explicit transitions: park the original task in `backlog` with `--no-start`, validate the unchanged Developer/contract/revision and complete project run inventory, then request `todo` with the explicit original Developer. This matches the deployed Multica trigger behavior. Each external write has a preceding durable intent. Updating a status successfully does not finish the operation.

Confirmation requires exactly one newly observed run with the original issue/Developer, a known state and creation time at or after the recorded request (Multica timestamps have second precision). Prior run IDs, statuses, actors, issue IDs, creation times, work directories and branch provenance, plus every other project issue's history, must remain unchanged. Source mappings, original PR, main, task ownership and frozen contract must still match. Missing/late output stays `enqueue_unconfirmed`; wrong, duplicate, changed or unavailable evidence stays held. A failed actual run is reported separately. The CLI has no atomic compare-and-swap or operation-token attribution: the shared operator lock plus fresh inventories are the supported coordination boundary, not server-side causal enforcement against an uncontrolled writer.

`serial.py inspect-recovery PIT-N` performs read-only reconciliation; it does not refresh metadata, mutate the ledger, create locks or enqueue. After a delayed/lost acknowledgement, the operator may use `serial.py confirm-recovery PIT-N --run EXACT_RUN_ID` to acknowledge the uniquely observed existing run. It requires active verified controller source and never repeats status writes. An interrupted parking step or an ambiguous/no-run result needs an explicit operator decision; neither command silently resumes it. Old PIT-62 one-off startup journals and subsequent reconciliation remain historical evidence; this follow-up does not rewrite them or start PIT-62 again.

Role submissions now retain explicitly declared evidence before either a passing or failing handoff. See the [role protocol](../../tooling/pipeline/ROLE_GUIDE.md). A complete local manifest can be verified after the native directory disappears; an incomplete copy never passes. Previous missing raw evidence remains a recorded gap.

Before using the changed controller, the operator performs fresh global evidence accounting over the v6 manifest roots and every later workspace evidence root, preserving high-water reservations for removed/shrunk evidence. Allocate a bounded part of the remaining **320,000,000-byte total cap** in local `.state/pipeline/evidence-budget.json`: `cap_bytes`, `accounted_bytes`, `allocation_bytes`, and `accounting_sha256` (SHA256 of that local accounting receipt). The allocation is reserved from global remaining capacity immediately; it does not reset that capacity. Retention, frozen logs and handoffs debit `.state/pipeline/evidence-reservations.json` under an independent storage lock, before writes. Reservations never refund on deletion or partial failure; changing a grant with an existing reservation ledger holds. Include the reservation ledger and remaining allocation in subsequent global accounting. Other local evidence producers must continue to honor the same global accounting; this is not an OS disk quota. Allocation authorizes only the already-scoped small local engineering evidence, not recording, installation, models or raw upload.

Activation stays invalid after these source changes until independent Reviewer/QA, exact-head CI, separately approved Squash integration and main CI pass. The completed stage-6 pilot remains paused. No new business task, parallel schedule, model or deployment is enabled by this repair.
