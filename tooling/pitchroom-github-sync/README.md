# Sync application source to private GitHub

From the workspace root, preview:

```sh
python3 tooling/pitchroom-github-sync/sync.py
```

Commit and push:

```sh
python3 tooling/pitchroom-github-sync/sync.py --push -m "Describe the change"
```

The original workspace history and staging area remain separate. `.pitchroom-github/` is an ignored, dedicated checkout of `shaunlidev/pitchroom` on `main`. Do not edit that checkout directly. The helper uses existing `git`, `gh` authentication and Python 3; it installs nothing. It confirms that the destination is private, fetches upstream, accepts only fast-forward updates, commits source changes and verifies the remote commit. It never force-pushes. A clean retry can push a previously created but unpushed commit. Diverged history or a dirty sync checkout stops for inspection.

`allowed-files.json` preserves the reviewed initial upload scope. New JS/TS/CSS source files under application code directories, numbered SQL migrations and numbered migration schema snapshots are included automatically. Other new JSON/config files and documentation must be explicitly added to the allowlist after review; deleting an allowed source file also deletes it remotely. Real-material configurations, participant records, environment files other than `.env.example`, databases, logs, keys, dependencies, builds and QA artifacts are excluded. Next.js generated declarations use standard build paths instead of local QA paths. The sync helper itself is also included.

Before transfer, every selected file must be UTF-8 text and pass filename and credential checks. Findings show only filename/line, never credential values. Synthetic test credentials and localhost example database URLs are permitted. A scanner cannot prove that arbitrary source text contains no private information: review the preview and code changes before pushing, especially new fixtures. The helper does not run application tests, real models, migrations or deployments. Run the relevant offline checks for your code change separately.

If a push fails, keep the checkout and retry the same command after fixing connectivity. If the helper reports a dirty checkout or divergence, inspect it instead of deleting/resetting it. A credential finding requires removing the real credential from source and using environment variables, not weakening the guard.

Offline verification of the export rules:

```sh
python3 -m unittest discover -s tooling/pitchroom-github-sync -p 'test_*.py'
```
