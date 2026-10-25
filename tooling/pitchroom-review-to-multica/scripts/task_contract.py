"""Nine-section planning contracts, source receipts, and non-dispatch readiness checks."""
import hashlib
from pathlib import Path
import re

PRIORITIES = {'high', 'medium', 'low', 'none'}
ROLES = {'planned_edit', 'read_only', 'planned_new'}
SCENARIOS = {'normal', 'refusal', 'failure', 'recovery'}


def validate_v2(proposal):
    root = Path(proposal['repo_root']).resolve()
    for task in proposal['tasks']:
        if task['task_type'] not in {'coordination', 'planning', 'implementation', 'verification'}:
            raise ValueError('Invalid task type')
        if task['priority']['value'] not in PRIORITIES or not task['priority']['reason']:
            raise ValueError('Priority needs a supported value and reason')
        if not task['deliverable'] or not task['preserve'] or not task['scope_expansion_rule'] or not task['completion']:
            raise ValueError('Missing bounded deliverable, invariants, expansion rule or completion')
        if task['file_plan_status'] not in {'bounded', 'partial', 'not_applicable'}:
            raise ValueError('Invalid file plan status')
        if not task['verification'] or not all(item.get('kind') and item.get('action') and item.get('evidence') for item in task['verification']):
            raise ValueError('Verification needs action and evidence')
        if {ac.get('case') for ac in task['acceptance']} != SCENARIOS:
            raise ValueError('Acceptance must cover normal, refusal, failure and recovery')
        approval = task['start_approval']
        if approval['status'] not in {'pending', 'approved'} or (approval['status'] == 'approved' and not approval.get('evidence')):
            raise ValueError('Approved start requires an explicit human evidence reference')
        if task['task_type'] in {'implementation', 'verification'} and not task['file_map']:
            raise ValueError('Implementation/verification requires a source map')
        for item in task['file_map']:
            if item['role'] not in ROLES or not item['reason']:
                raise ValueError('File receipt needs role and reason')
            relative = Path(item['path'])
            path = (root / relative).resolve()
            if relative.is_absolute() or not path.is_relative_to(root) or any(part in relative.parts for part in ['archive', '.trash', '.git', 'node_modules']) or any(part.startswith('.env') for part in relative.parts):
                raise ValueError('File map must use safe repository-relative paths')
            if item['role'] == 'planned_new':
                if path.exists() or not item.get('purpose'):
                    raise ValueError('New file must be absent and have an exact purpose')
            else:
                if not path.is_file() or hashlib.sha256(path.read_bytes()).hexdigest() != item['sha256']:
                    raise ValueError('Mapped source changed; re-inspect before preview/apply')
                text = path.read_text()
                if not item['symbol'] or item['symbol'] not in text or not isinstance(item['line'], int) or item['line'] < 1 or item['line'] > len(text.splitlines()) or item['symbol'] not in text.splitlines()[item['line']-1]:
                    raise ValueError('File symbol/line receipt is not supported by source')
        if not task['forbidden_paths']:
            raise ValueError('Explicit protected paths required')
        for item in task['file_map']:
            if item['role'] == 'planned_edit' and any(Path(item['path']).match(pattern) for pattern in task['forbidden_paths']):
                raise ValueError('Planned edit overlaps a protected path')
        for dep in task['dependencies']:
            if dep['kind'] not in {'hard', 'recommended', 'parallel'} or not dep['reason'] or not dep['completion_condition']:
                raise ValueError('Dependency requires kind, reason and completion condition')
            if not re.fullmatch(r'PIT-\d+', dep['issue']):
                raise ValueError('Dependency must reference an existing Pitchroom issue')


def readiness(task, inventory):
    if task['task_type'] in {'planning', 'coordination'}:
        return {'verdict': 'not_implementation', 'blockers': ['This is a planning/coordination deliverable, not an implementation authorization.']}
    by_key = {row['identifier']: row for row in inventory}
    blockers = []
    if task['start_approval']['status'] != 'approved':
        blockers.append('No explicit approval to start this task.')
    if task['open_decisions']:
        blockers += ['Open product decision: ' + decision for decision in task['open_decisions']]
    if task['file_plan_status'] != 'bounded':
        blockers.append('File map is partial; resolve the named contract/migration questions first.')
    for dep in task['dependencies']:
        if dep['kind'] == 'hard':
            row = by_key.get(dep['issue'])
            if not row or row['status'] != 'done' or not dep.get('accepted_evidence'):
                blockers.append('Hard prerequisite not accepted: ' + dep['issue'])
    return {'verdict': 'not_ready' if blockers else 'ready_for_reviewed_execution', 'blockers': blockers}


def check_dependencies(proposal, inventory):
    by_issue = {row['identifier']: row for row in inventory}
    graph = {task.get('match_issue', task['key']): [dep['issue'] for dep in task['dependencies'] if dep['kind'] == 'hard'] for task in proposal['tasks']}
    seen, active = set(), set()
    def visit(key):
        if key in active:
            raise ValueError('Hard prerequisite cycle')
        if key in seen:
            return
        active.add(key)
        for dep in graph.get(key, []):
            if dep not in by_issue:
                raise ValueError('Dependency issue unavailable in this project: ' + dep)
            visit(dep)
        active.remove(key)
        seen.add(key)
    for task in proposal['tasks']:
        for dep in task['dependencies']:
            if dep['issue'] not in by_issue:
                raise ValueError('Dependency issue unavailable in this project: ' + dep['issue'])
        visit(task.get('match_issue', task['key']))


def render_v2(task, proposal, start, end, gate):
    lines = [start, '## Proposed current task contract · v2', '', 'This proposed contract revises earlier planning guidance, which is preserved above as history. It requires explicit confirmation before synchronization. No implementation or Agent dispatch is authorized.', '',
             '### 1. User outcome and review evidence', task['outcome'], f"Source: `{proposal['review_path']}`", f"Review SHA-256: `{proposal['review_sha256']}`"]
    lines += ['- '+ref['heading']+': '+ref['quote'] for ref in task['references']]
    lines += ['', '### 2. Priority and reason', task['priority']['value']+' · '+task['priority']['reason'], '', '### 3. Prerequisites and execution order']
    lines += [f"- {dep['kind']}: [{dep['issue']}](http://localhost:3100/pitchroom/issues/{dep['issue']}). {dep['reason']} Accepted when: {dep['completion_condition']}" for dep in task['dependencies']]
    lines += ['- Recommended order is not a hard gate. Parallel work still requires file ownership coordination.', '', '### 4. Bounded deliverable', task['deliverable'], '', '### 5. Scope and protected behavior', task['scope'], 'Preserve:']
    lines += ['- '+text for text in task['preserve']]+['Out of scope:']+['- '+text for text in task['non_goals']]
    lines += ['Protected paths:']+['- `'+path+'`'for path in task['forbidden_paths']]+['Expansion rule: '+task['scope_expansion_rule'], '', '### 6. Source map and evidence', 'File plan: '+task['file_plan_status']+'. These receipts locate current code, not proof that a future implementation needs no additional design.']
    lines += [f"- {item['role']}: `{item['path']}:{item.get('line', '')}` · `{item.get('symbol', 'new file')}`. {item['reason']} SHA-256: `{item.get('sha256', 'not created')}`"for item in task['file_map']]
    lines += ['', '### 7. Observable acceptance']+[f"- [ ] {ac['case']} / {ac['kind']}. Given/when {ac['scenario']}. Expected: {ac['expected']}" for ac in task['acceptance']]
    lines += ['', '### 8. Verification, evidence and open decisions']+[f"- {v['kind']}: {v['action']}. Evidence: {v['evidence']}"for v in task['verification']]
    lines += ['Open decisions:']+['- '+v for v in task['open_decisions']]
    lines += ['', '### 9. Start gate and completion', 'Observed gate: '+gate['verdict']]+['- '+v for v in gate['blockers']]
    lines += ['Completion: '+task['completion'], 'Gate result is advisory and read-only. It never changes status, assigns work, starts an Agent, or grants model/recording budget.', '', end]
    return '\n'.join(lines)
