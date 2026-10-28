# QA skill loading and temporary instructions

Pstack remains installed in the local Codex skill tree. Multica QA has a separately assigned `pitchroom-qa-pstack` bridge whose maintained source is `tooling/pipeline/skills/pitchroom-qa-pstack/SKILL.md`. The bridge loads the local `poteto-mode/SKILL.md` and requires actual verification evidence. Updating `instructions` alone leaves this assignment intact. Skill assignment is required in addition to any convenience reminder in the role prompt.

PIT-67 traced the lost rule to a bootstrap operator cleanup in the chat “审视 Pitchroom 协作方式”. After PIT-66 QA completed, the operator restored the whole saved `before-qa.json` instructions. The snapshot predated a concurrent pstack addition, so the cleanup erased it. This was an operator command, not a serial-controller instruction sync. Do not change historical snapshots or QA evidence to fix it.

For future temporary overrides, save the exact added section as a separate local file. After the run ends, read the current instructions and calculate their SHA-256. Preview removal with:

```sh
python3 tooling/pipeline/agent_instructions.py AGENT_ID \
  --remove-note-file .pipeline-local/owned-note.md \
  --expected-sha256 CURRENT_INSTRUCTIONS_SHA256
```

Add `--apply` after reviewing the preview. The helper rereads current state, refuses an active agent or stale/changed/ambiguous section, removes only that section, writes only instructions and verifies exact readback. Never pass a whole baseline snapshot as the section. A mismatched readback is uncertain; stop without retrying. The CLI exposes no atomic compare-and-swap, so independent writers must coordinate. This helper detects intervening changes before its write and unexpected readback; it cannot prevent an arbitrary outside writer from replacing configuration afterward. Separate skill assignment keeps pstack independent of instructions-only cleanup.

To configure the bridge, use the official Multica skill create/update command with its source body, then `multica agent skills add QA_AGENT_ID --skill-ids BRIDGE_ID`. Read back both the skill body and the assignment. Do not replace other assignments. A bridge is a local-entry adapter, not a second copy of pstack. Remote runtimes need a separately validated skill path.

Verify a new actual QA run after binding. Its tool trace must show reads of the pstack entry and relevant playbook/leaf files, followed by meaningful checks whose commands and results match its local report. Prompt text, a skill assignment, or the agent saying it used pstack alone is insufficient. Preserve failures and distinguish this workflow verification from product acceptance.
