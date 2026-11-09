# Bounded context and coordination

Owner: Pitchroom engineering workflow. Scope: PIT-98, approved 2026-11-09. These rules reduce repeated observations and coordination; they grant no execution permissions. Product/design authority and the complete [delivery protocol](PIPELINE.md) remain unchanged.

## Read what changed

Read the authority entry and the task's scoped requirements first. Reuse a complete source read only while its content is still available in the same context and its SHA-256 is unchanged. After compaction, a new chat, a new role run, a branch/worktree change, or loss of the source content, start a new context ID or force a new read. A summary or fingerprint alone never proves the full source is available.

From the task checkout:

```sh
python3 tooling/pipeline/context_budget.py read AGENTS.md SOURCE_OF_TRUTH.md --context PIT-98-developer-context-1 --budget 12000
```

The helper returns full new/changed text and only fingerprints for previously delivered unchanged text. Its ignored `.pipeline-local/context/` receipt belongs to one writer in this task checkout. Do not share context IDs/receipts across concurrent workers. It performs no model, network, shell or test calls. Missing/private/symlink inputs and damaged receipts fail. Files that do not fit are labelled `needs_targeted_read`, omitted from the complete-read receipt and cause exit 2; open the necessary ranges directly and keep omissions explicit. The limit is serialized output characters, not a token or money estimate. `--force` rereads an input regardless of its receipt.

Mandatory independent reads override reuse: every new QA run still loads its assigned local pstack entry and QA-scoped playbook. Do not restart active QA. Do not use a read receipt as a test, acceptance, runtime readiness or approval receipt.

For Multica, use the CLI's compact fields, then comment roots with `--roots-only --summary --compact`, then one required thread with `--thread ID --tail N --compact`. `--recent N` limits threads, not their descendants. Save large results locally and return selected fields. Do not return entire histories or full board descriptions to answer one card's state. Raw QA remains local and its storage cap still applies.

## Observe at a defined boundary

Observe at task entry, a planned report checkpoint, a completion/failure/user event, one declared wait deadline, or immediately before a state-changing decision. Use the existing canonical `status.py --live --issue PIT-N` for authoritative operational inspection. Prefer the active command's completion signal or existing agent notification to repeated `ls`, CI queries, full-board reads, `list_agents`, or status messages. Choose one bounded wait and a deadline; if the operation is still pending at the deadline, report pending/hold or perform one scoped diagnostic that answers a named question. Do not automatically start another identical wait/query cycle. Do useful independent work when available.

A cached status may explain past progress only. Side effects still require the existing fresh identity, head, CI, contract, capacity and approval checks within their actual validity window. An unavailable or stale observation remains unknown. Never cache away an authorization check or extend the controller's observation lifetime. This rule does not alter the controller's authorized internal polling or activate any schedule/monitor.

## One complete handoff

Use an existing worker for its unchanged assignment; do not send “still working?” follow-ups. Send another message only for changed scope/authority, new evidence that changes the work, a concrete question/blocker, or a requested decision. A message is not a new assignment. If a worker exits with incomplete required work, reconcile why before starting another run. Parallel work needs explicit authority, independent owned files and a reason it reduces elapsed work; do not add roles solely to repeat the same investigation.

Prepare one packet with exactly these fields; all except the three identity strings are nonempty lists of explicit statements:

- `issue`, `role` (`developer`, `reviewer`, `qa` or `advisory`), `head` (full source commit).
- `scope`: owned paths, exclusions, base/worktree and relevant dirty/environment/fixture identity.
- `permissions`: the actual authority reference and explicit action limits; a packet cannot grant new authority.
- `deliverable`, `acceptance`: concrete output and every original applicable criterion, with the full owning issue linked if needed. The size limit never permits dropping required criteria.
- `evidence`: required source/contract hashes, existing reports and local evidence paths; historical evidence is not a fresh pass.
- `stop_conditions`: missing decisions, unknown outcomes, capacity limits and the existing two-repair cap.
- `report_to`: one return location and expected result/failure/not-run fields.
- `wait_for`: expected completion event, finite deadline and pending/hold action on timeout.

Validate a local packet before an already authorized handoff:

```sh
python3 tooling/pipeline/context_budget.py handoff .pipeline-local/handoff.json
```

The validator checks field presence, shape, immutable-head syntax and a 12000-character bound. It neither verifies the live issue/commit nor dispatches, approves or modifies role instructions. A large original contract must remain complete through a scoped immutable reference that the independent role actually reads. A successful syntax check is never delivery acceptance.

## Preserve independent verification

Developer → exact-head CI → independent Reviewer → independent QA → human exact-head Squash approval → actual main CI remains required. Each role checks its own applicable contract; a Developer result cannot stand in for an independent role's work. Required QA skills, black-box isolation, explicit Apply/Keep/Undo and human product acceptance remain separate.

Within one role, reuse a passing check only when its exact source/head, uncommitted diff, check implementation, dependencies/configuration, environment, fixtures and acceptance scope remain valid and the protocol permits it. A new head requires fresh checks. A real change/failure justifies targeted rerun; “checking again” alone does not. Retain the original failure and all required evidence. Stop before a third unsuccessful evidence-led repair.

At handoff/compaction, leave one small checkpoint: issue/head/tree/dirty state; completed work; exact receipt paths/hashes and failures/not-run; loaded source/skill versions that remain accessible; next action; pending authority; expected event/deadline. Close the context at that boundary rather than carrying a project-wide chat into another unrelated slice. Completion, acceptance, merge and deployment remain distinct.

## Limits

The helper mechanically bounds its own reads and packet shape. Agent instructions govern polling and communication outside it; the helper is not an OS boundary or a global token limiter. Measured savings require a comparable future delivery and the same acceptance scope; no percentage reduction is claimed by this change. Product model calls, installations, recordings, deployment and paused scheduling retain their existing authorization gates.
