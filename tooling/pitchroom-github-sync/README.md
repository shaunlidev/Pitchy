# Serial task branches and Draft PR delivery

Legacy snapshot `sync.py --push` is retired. Original local work is retained. New tasks use the GitHub repository's common history. Both migration/pilot PRs remain Draft and unmerged; only one task lane is authorized.

From an approved task worktree:

```sh
python3 tooling/pitchroom-github-sync/delivery.py install-hook
python3 -B -m unittest discover -s tooling/pitchroom-github-sync -p 'test_*.py'
python3 tooling/pitchroom-github-sync/delivery.py audit HEAD
# After a scoped local commit:
git push -u origin HEAD
# Explicit base; body file is local and ignored:
gh pr create --draft --base codex/pit-30-git-baseline --title 'PIT-N: describe the change' --body-file .pipeline-local/pr.md
```

The shared `pre-push` hook permits only origin at the exact private Pitchroom URL and non-deletion `codex/pit-N-description` branch updates. It blocks main, tags and non-fast-forward history. Every outgoing commit is scanned, including credentials removed in a later commit. Checks use committed blobs, reject unknown paths, symlinks, binaries, runtime/data/QA files and likely credentials; findings never print credential values.

The hook references its retained tool checkout by absolute path. Keep that checkout until reinstalling from a permanent one; missing tools fail closed. Existing unrelated hooksPath is preserved. Local hooks can be deliberately bypassed by an owner and do not provide GitHub-enforced branch protection. Review all new fixtures and configuration: scanning cannot prove that arbitrary prose is free of private information.

Reviewer and QA run sequentially in separate detached worktrees at the exact PR head. New commits invalidate earlier review. Reports include outcome, evidence, gaps and choices, while raw evidence remains local. Do not merge or mark done during this pilot. Unattended dispatch and parallel rollout stay disabled. After the baseline is accepted, use an explicitly integrated base for later tasks.
