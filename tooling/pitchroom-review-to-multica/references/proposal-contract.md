# Proposal v2 contract

The host model drafts semantics from the review and live inventory. The synchronizer validates evidence and creates a read-only preview. It does not infer business priority or approve work by itself.

Keep `scope=v6-local-core`, an absolute `repo_root`, review path/hash, stable task keys, exact review quotations, explicitly matched existing issue IDs, and complete V6 coverage dispositions. Schema v1 remains readable for legacy offline tests; use v2 for new plans.

Each v2 task retains `title`, `outcome`, `scope`, `non_goals`, `references`, `acceptance`, and `open_decisions` and adds:

| Field | Contract |
|---|---|
| `task_type` | coordination, planning, implementation, or verification |
| `priority` | value (high/medium/low/none), reason |
| `dependencies` | each has existing PIT issue, kind (hard/recommended/parallel), reason, completion_condition, and accepted_evidence when actually accepted |
| `deliverable` | bounded reviewable output |
| `preserve` | invariants that may not be weakened |
| `forbidden_paths` | explicit protected path patterns |
| `scope_expansion_rule` | require reviewed expansion before editing elsewhere |
| `file_plan_status` | bounded, partial, or not_applicable |
| `file_map` | exact repository-relative path, role (planned_edit/read_only/planned_new), reason; existing files require SHA-256, symbol and current matching line; new files require purpose and must be absent |
| `acceptance` | each has case (normal/refusal/failure/recovery), kind (deterministic/browser/model/human), scenario and expected result |
| `verification` | each has kind, action, evidence expected |
| `start_approval` | pending, or approved with an actual explicit human evidence reference; task synchronization is not start approval |
| `completion` | evidence and human review gate |

Leave v1 `depends_on` and `external_dependencies` empty when v2 `dependencies` is authoritative. Reference an index without reparenting other owners' work. New hard dependencies must not form cycles or point outside the project. Report coverage for all 16 V6 IDs plus explicit deferrals for production, complex formats, PDF/AT and product-value evidence.

Preview embeds the nine-section contract, current start verdict, original issue snapshot, proposed description, source receipts, priority field deltas, execution-history digest, engine source hash and approval digest. Only explicitly reviewed description/priority changes may be applied. Keep status/assignee/parent/stage untouched. Human prose outside managed markers stays unchanged, even when older notes are superseded by the proposed current contract.

`check-ready` is a read-only gate report. It does not choose an Agent, activate a status, run product tests, spend model budget, or change files. Missing start approval, unresolved product decisions, partial source map, or unaccepted hard dependencies fail the implementation gate. Planning/index work is separately classified. File receipts are structural source support, not semantic proof that the edit plan is complete.

Preview files are immutable. Any changed source receipt, report, engine, issue, priority or run history requires reconciliation. Journaled uncertain writes require inspection rather than blind retry. CLI updates cannot provide atomic compare-and-swap; coordinate concurrent human edits during an approved apply. A fake-CLI test pass does not establish actual remote writes.
