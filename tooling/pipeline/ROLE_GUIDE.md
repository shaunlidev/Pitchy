# Serial role protocol

Use the absolute canonical `tooling/pipeline/serial.py` from your actual native Multica worktree. Do not execute task copies, change central state/config, call core controller.py directly, mention another Agent, or change issue status yourself. The existing dispatcher tick owns transitions only after the submitting process is terminal. Ordinary local role processes are not an OS authorization boundary.

Developer:

1. `serial.py workspace PIT-N --workdir "$PWD"` binds actual issue/run/workspace and copies installed dependencies without installs. Before any change, a rework must preserve every prior public-delivery source path. Missing prerequisites/decisions are holds.
2. Write `.pipeline-local/plan.json` preserving every returned requirement verbatim: `engineering:true`, `decisions:[]`, `criteria:[{id,text,kind:"engineering",required:true,check_ids:["normal"]}]`, `checks:{normal:{argv:["node","path/to/committed-check.cjs"],cwd:".",proof:{kind:"json",pointer:"/passed",equals:true}}}`, and exact `allowed_paths`. Register with `serial.py plan PIT-N --report .pipeline-local/plan.json`. Checks must assert real observable behavior; no empty PASS, waived criteria, weakened tests or unapproved network/model/DB/installs. Automatic tasks cannot modify the controller/governance.
3. Implement scoped paths. Write report `{outcome,criterion_results:[{id,status:"pass"}],gaps:[],decisions:[]}` for every criterion. `serial.py stage PIT-N --role developer --workdir "$PWD" --report .pipeline-local/report.json` creates a source-only immutable artifact, runs frozen checks and creates a guarded task branch/Draft PR. Runtime AGENTS and native runtime history stay local. Stop after submission. No manual handoff.

Reviewer/QA:

1. `serial.py checkout PIT-N --role reviewer|qa --workdir "$PWD"` materializes the exact public artifact in a separate detached checkout. Work only there; do not assume native source contains delivery. No source/test edits. Reviewer checks complete original contract and actual diff, including assertion coverage; when complete include `complete_contract_review:true`.
2. Independently inspect/test the applicable criteria. QA uses isolated synthetic state; during black-box browser checks do not read app source. No recordings, provider calls, new installations or private databases without separate authority. Raw QA stays local.
3. Submit the same report shape with `serial.py stage ... --role reviewer|qa --report .pipeline-local/report.json`. The controller independently reruns the frozen commands and validates exact actor/run/commit/tree/contract/check receipts. Stop. QA PASS means waiting for human merge, never automatic merge or product acceptance.

For a defect, use `serial.py return PIT-N --role reviewer|qa --report ... --rework`; for missing evidence/decision use it without `--rework`. Include specific gaps/decisions. At most two repairs; old generations and PRs are retained. Do not weaken criteria to clear a gate. Rework publishes a new generation PR retaining the previous delivery ancestor; predecessor PR remains preserved, never falsely counted as merged.

The tick polls GitHub before dispatch/transition. Exact current-head CI from the pinned workflow is required before review/QA handoff. Pending/failed/missing/skipped/cancelled checks hold. Runtime errors or uncertain writes hold for reconciliation. Waiting for CI or merge occupies the one lane. Only a human-approved merge with retained artifact ancestry and passing exact merge-commit CI can finish a new controlled engineering task. Legacy/in-review tasks are not silently adopted or auto-closed.
