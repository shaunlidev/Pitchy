# Demonstrate one local positioning decision

This walkthrough uses synthetic input and deterministic fixture output. Say that before starting. Do not describe the fixture as a real-model generation or an independent user test.

The target is a three-to-five-minute presentation after startup. Compilation and model latency are not included in that presentation target. The timing has not been measured as a user-efficiency result.

## Start an isolated fixture

Use an existing checkout with installed dependencies and Node.js 24. Do not install missing dependencies for this demonstration. Use a disposable source checkout without private files. If dependencies are reused by symlink, keep internal `@pitchroom/*` links pointed at that checkout and record the reuse.

From the repository root, set `PITCHROOM_DEMO_NODE` to the absolute path of the existing Node executable. Run:

```sh
python3 - <<'PY'
import os
from pathlib import Path

root = Path.cwd()
app = root / "pitchroom-app"
web = app / "apps/web"
names = [".env", ".env.local", ".env.development", ".env.development.local"]
for folder in [root, app, web]:
    for name in names:
        if (folder / name).exists():
            raise SystemExit("Use a disposable checkout without private environment files.")
node = Path(os.environ["PITCHROOM_DEMO_NODE"])
entry = web / "node_modules/next/dist/bin/next"
if not node.is_file() or not entry.is_file():
    raise SystemExit("Existing Node and application dependencies are required. Nothing was installed.")
env = {key: os.environ[key] for key in ["HOME", "TMPDIR", "LANG"] if key in os.environ}
env.update(PATH=str(node.parent) + ":/usr/bin:/bin",
           PITCHROOM_RUNTIME="fixture", PITCHROOM_ISOLATED_QA="1",
           NEXT_TELEMETRY_DISABLED="1", NODE_ENV="development")
os.chdir(web)
os.execve(str(node), [str(node), str(entry), "dev", "--webpack",
                     "--hostname", "127.0.0.1", "--port", "43891"], env)
PY
```

The expected startup output names `http://127.0.0.1:43891` and reports Ready. If the port is occupied, stop this launch and choose another port. Do not use or stop an unknown existing server.

Open that address in a fresh browser context. Confirm **Synthetic project · Local session**. The health endpoint must report runtime `fixture`. No database or provider credentials are supplied by this procedure.

If the page says **Opening your project…**, wait for the actual input controls. Seeing a main element is insufficient because the loading state also uses one. An empty brief can show **Save cleared brief**. Enter text before looking for **Save brief**.

## Show the decision

Use this synthetic brief:

> The approved pilot cohort contains twelve teams. A 50% time-saving target is unverified. Budget and final buyer are unknown.

1. Paste the brief and select **Save brief**. Show the saved material state.
2. Select **Run understanding agent**. Show that the result stops for review. Inspect the source rather than calling the target achieved performance.
3. Accept the Understanding version as a scripted synthetic operator. Continue to Positioning and create the directions.
4. Explain the recommendation and the difference between **Evidence first** and **Decision first**. Preview the other direction. Point out that preview has not applied it.
5. Explicitly use the alternative direction. This demonstrates control over the recommendation. It is not a real consultant's preference observation.
6. Develop a working Story. Show the candidate preview. Dismiss it once, then develop and explicitly Apply a candidate. Explain why a saved candidate is different from the adopted Story.
7. Review Deck inputs and confirm creation from the adopted Story. Inspect a page and its supporting material. Deck V2 copies the adopted content without another model pass.
8. Edit one page and save a new draft. Inspect the previous draft and use **Return to current draft** to resume. Reload can retain a selected historical draft rather than switching to the latest one. Keep manual wording separate from evidence-reviewed wording.

Keep the spoken narrative focused on the choice and its consequences. Do not read every provenance field or turn the demo into a tour of the delivery pipeline.

## Disclose the fallback

If the interface is unavailable, use the [architecture](architecture.md) and [dated failure analysis](failure-analysis.md). Say which result is historical and which interaction is scripted. Do not show an old passing result as a new execution.

Fixture state is in memory. A page reload can read state from the same process. Restarting the fixture server clears that saved project. This walkthrough does not establish database or worker restart recovery.

Stop the owned server when finished. No screenshot, video, trace, provider call, or public deployment is required. Recording and publication remain separate decisions.
