# Pitchroom engineering entry

Read SOURCE_OF_TRUTH.md and the relevant v6 product/design documents before implementation. This is the source-only engineering repository; the old local workspace and Git history are retained separately. Do not import their databases, environment files, runtime state, participant materials, archive or raw QA.

Current user authorization (2026-10-26): establish a common Git history; run one task through an independent worktree, Draft PR, Reviewer and QA. One task lane only. No automatic dispatch, merge, parallel rollout, deployment, new installation, real product-model call, recording or external outreach. Existing scheduled dispatch is paused.

Use task branches named codex/pit-N-description. Never push main, force-push, reset/clean/stash the user's work, or bypass the safety gate. Developer and Reviewer/QA must identify the same immutable commit. Reviewer and QA run sequentially, keep source unchanged and report original acceptance criteria, actual commands, failures and not-run checks. Raw evidence stays local. Product acceptance and deployment are distinct from engineering verification. Do not mark done while the Draft PR remains unmerged.

Protected original v6 artifacts are unchanged; this checkout contains only selected v6 text documents. Missing screenshots/prototype/raw evidence are excluded deliberately and are not fresh passes. No dependency installation is authorized by setup instructions.
