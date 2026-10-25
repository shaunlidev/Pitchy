#!/usr/bin/env python3
"""Preview-first Pitchroom issue synchronization through the official CLI."""
import argparse
import difflib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
from task_contract import validate_v2, readiness, check_dependencies, render_v2

TARGET = {'server': 'http://localhost:8180', 'workspace': '824f2f2e-b815-4117-90d5-af284a4eccec', 'project': 'e9b58af4-e44d-40a3-b0d6-65efd204356f'}
FIELDS = ('id', 'identifier', 'title', 'description', 'status', 'assignee_id', 'assignee_type', 'parent_issue_id', 'stage', 'priority')
TERMINAL = {'done', 'cancelled'}
KINDS = {'deterministic', 'browser', 'model', 'human'}


def engine_hash():
    paths = [Path(__file__), Path(__file__).with_name('task_contract.py')]
    return hashlib.sha256(b''.join(path.read_bytes() for path in paths)).hexdigest()


def digest(value):
    return hashlib.sha256(json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def read(path):
    return json.loads(Path(path).read_text())


def write(path, value):
    path = Path(path)
    fd, temp = tempfile.mkstemp(dir=path.parent, prefix='.sync-')
    try:
        with os.fdopen(fd, 'w') as stream:
            json.dump(value, stream, ensure_ascii=False, indent=2)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def safe_error(message):
    return re.sub(r'(?:mul_|mcn_|sk-)[A-Za-z0-9_-]+|Bearer\s+\S+', '[REDACTED]', message)[:1500]


def snapshot(issue):
    return {key: issue.get(key) for key in FIELDS}


def unwrap(value):
    return value.get('issue', value)


class CLI:
    def __init__(self, profile=None):
        self.base = ['multica'] + (['--profile', profile] if profile else [])
        self.target = self.base + ['--server-url', TARGET['server'], '--workspace-id', TARGET['workspace']]

    def raw(self, args, target=True):
        result = subprocess.run((self.target if target else self.base) + args, capture_output=True, text=True, timeout=60)
        if result.returncode:
            raise RuntimeError(safe_error(result.stderr or result.stdout))
        return result.stdout

    def call(self, args):
        return json.loads(self.raw(args + ['--output', 'json']))

    def check(self):
        version = self.raw(['version'], target=False)
        match = re.search(r'(\d+)\.(\d+)\.(\d+)', version)
        if not match or tuple(map(int, match.groups())) < (0, 4, 26):
            raise ValueError('multica >=0.4.26 required; no installation performed')
        config = self.raw(['config', 'show'], target=False)
        values = dict(re.findall(r'^\s*(server_url|workspace_id):\s*(\S+)', config, re.M))
        if values != {'server_url': TARGET['server'], 'workspace_id': TARGET['workspace']}:
            raise ValueError('Selected CLI profile must already target the local Pitchroom workspace')
        workspaces = self.call(['workspace', 'list'])
        if not isinstance(workspaces, list) or not any(x['id'] == TARGET['workspace'] for x in workspaces):
            raise ValueError('Authenticated Pitchroom workspace required')
        projects = self.call(['project', 'list'])
        projects = projects if isinstance(projects, list) else projects.get('projects', [])
        if not any(x['id'] == TARGET['project'] for x in projects):
            raise ValueError('Pitchroom project unavailable')

    def issues(self):
        rows = []
        for offset in range(0, 2000, 100):
            page = self.call(['issue', 'list', '--project', TARGET['project'], '--limit', '100', '--offset', str(offset)])
            rows += page['issues']
            if not page.get('has_more'):
                return rows
        raise ValueError('Issue inventory exceeds bounded pagination; no partial preview')

    def get(self, issue_id):
        issue = unwrap(self.call(['issue', 'get', issue_id]))
        if issue['project_id'] != TARGET['project']:
            raise ValueError('Cross-project issue rejected')
        return issue


def validate(proposal, report):
    if proposal.get('schema_version') not in {1, 2} or proposal.get('scope') != 'v6-local-core':
        raise ValueError('Expected schema_version 1/2 and scope=v6-local-core')
    if proposal['review_sha256'] != hashlib.sha256(report.encode()).hexdigest():
        raise ValueError('Review changed; regenerate the AI proposal')
    keys = [task['key'] for task in proposal['tasks']]
    titles = [normalized_title(task['title']) for task in proposal['tasks']]
    if len(titles) != len(set(titles)):
        raise ValueError('Duplicate normalized task titles within proposal')
    if len(keys) != len(set(keys)) or not keys:
        raise ValueError('Task keys must be unique and nonempty')
    for task in proposal['tasks']:
        if not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,63}', task['key']):
            raise ValueError('Invalid stable task key')
        if not all(task.get(k) for k in ['title', 'outcome', 'scope', 'non_goals', 'references', 'acceptance']):
            raise ValueError('Task lacks scope, provenance, or acceptance')
        for ref in task['references']:
            if ref['heading'] not in report or not ref['quote'] or ref['quote'] not in report:
                raise ValueError('Task reference is not present in the review')
        for ac in task['acceptance']:
            if ac.get('kind') not in KINDS or not ac.get('scenario') or not ac.get('expected'):
                raise ValueError('Acceptance needs kind, scenario, expected; thresholds must come from evidence')
        if any(dep not in keys for dep in task.get('depends_on', [])):
            raise ValueError('Unknown task dependency')
        if 'mention://' in json.dumps(task, ensure_ascii=False):
            raise ValueError('Mention links are not allowed in generated task content')
    visiting, seen = set(), set()
    tasks = {task['key']: task for task in proposal['tasks']}
    def visit(key):
        if key in visiting:
            raise ValueError('Dependency cycle')
        if key in seen:
            return
        visiting.add(key)
        for dep in tasks[key].get('depends_on', []):
            visit(dep)
        visiting.remove(key)
        seen.add(key)
    for key in keys:
        visit(key)
    ids = re.findall(r'\| (MAT-\d+|CLR-\d+|POS-\d+|DCK-\d+|X-\d+) ·', report)
    coverage = {item['id']: item for item in proposal['coverage']}
    if not set(ids).issubset(coverage):
        raise ValueError('V6 requirement dispositions missing')
    for item in proposal['coverage']:
        if item['disposition'] not in {'task', 'reuse', 'defer', 'exclude', 'preserve'} or not item['reason']:
            raise ValueError('Coverage must state an explicit disposition and reason')
        if any(key not in tasks for key in item.get('task_keys', [])):
            raise ValueError('Coverage references unknown task')
    if proposal['schema_version'] == 2:
        validate_v2(proposal)
    return tasks


def marker(key):
    return f'<!-- pitchroom-review:{key} -->', f'<!-- /pitchroom-review:{key} -->'


def render(task, proposal, gate=None):
    start, end = marker(task['key'])
    if proposal['schema_version'] == 2:
        return render_v2(task, proposal, start, end, gate)
    lines = [start, '## Review-linked planning contract', '', 'Planning draft only. No Agent execution, assignment, status activation, commit, or deployment is authorized.', '',
             f"Source: `{proposal['review_path']}`", f"Review SHA-256: `{proposal['review_sha256']}`", '', '### Evidence']
    lines += [f"- {ref['heading']}: {ref['quote']}" for ref in task['references']]
    lines += ['', '### User outcome', task['outcome'], '', '### Scope', task['scope'], '', '### Non-goals']
    lines += ['- ' + text for text in task['non_goals']]
    lookup = {item['key']: item for item in proposal['tasks']}
    lines += ['', '### Dependencies'] + ['- ' + (f"[{lookup[key]['match_issue']}](http://localhost:3100/pitchroom/issues/{lookup[key]['match_issue']})" if lookup[key].get('match_issue') else key) for key in task.get('depends_on', [])]
    lines += ['- Existing issue ' + key for key in task.get('external_dependencies', [])]
    lines += ['', 'Dependencies are planning links, not scheduler authorization.', '', '### Acceptance draft']
    for ac in task['acceptance']:
        lines += [f"- [ ] [{ac['kind']}] Given/when {ac['scenario']}. Expected: {ac['expected']}"]
    lines += ['', '### Product decisions still open'] + ['- ' + text for text in task.get('open_decisions', [])]
    lines += ['- Acceptance thresholds absent from the review remain undecided. Generated criteria require human review.', '', end]
    return '\n'.join(lines)


def merged_body(body, task, proposal, gate=None):
    start, end = marker(task['key'])
    if body.count(start) != body.count(end) or body.count(start) > 1 or (start in body and body.index(end) < body.index(start)):
        raise ValueError('Malformed managed region')
    block = render(task, proposal, gate)
    if start in body:
        return body[:body.index(start)] + block + body[body.index(end) + len(end):]
    return body.rstrip() + ('\n\n' if body else '') + block


def normalized_title(title):
    return re.sub(r'\W+', '', title.casefold())


def preview(proposal, report, inventory, runs_by_id=None):
    runs_by_id = runs_by_id or {}
    validate(proposal, report)
    if proposal['schema_version'] == 2:
        check_dependencies(proposal, inventory)
    operations, claimed = [], set()
    for task in proposal['tasks']:
        start, _ = marker(task['key'])
        candidates = [issue for issue in inventory if start in (issue.get('description') or '')]
        if task.get('match_issue'):
            explicit = [issue for issue in inventory if issue['identifier'] == task['match_issue']]
            if len(explicit) != 1:
                raise ValueError(f"Explicit match {task['match_issue']} does not resolve uniquely")
            candidates += explicit
        candidates += [issue for issue in inventory if normalized_title(issue['title']) == normalized_title(task['title'])]
        candidates = {issue['id']: issue for issue in candidates}
        if len(candidates) > 1:
            raise ValueError(f"Ambiguous duplicate candidates for {task['key']}; manual matching required")
        issue = next(iter(candidates.values()), None)
        if issue and issue['id'] in claimed:
            raise ValueError('Two task keys target one issue')
        if issue:
            claimed.add(issue['id'])
        gate = readiness(task, inventory) if proposal['schema_version'] == 2 else None
        body = merged_body((issue.get('description') or '') if issue else '', task, proposal, gate)
        changes = {}
        if proposal['schema_version'] == 2 and (not issue or issue.get('priority') != task['priority']['value']):
            changes['priority'] = {'before': issue.get('priority') if issue else None, 'after': task['priority']['value']}
        kind = 'create' if not issue else 'unchanged' if body == (issue.get('description') or '') and not changes else 'update'
        conflict = bool(issue and kind == 'update' and (issue['status'] != 'backlog' or issue.get('assignee_id')))
        operations.append({'key': task['key'], 'kind': 'conflict' if conflict else kind, 'issue_id': issue['id'] if issue else None,
                           'identifier': issue['identifier'] if issue else None, 'title': task['title'], 'before': snapshot(issue) if issue else None,
                           'field_changes': changes, 'start_gate': gate,
                           'before_runs_sha256': digest(runs_by_id.get(issue['id'], [])) if issue else digest([]),
                           'description': body, 'diff': ''.join(difflib.unified_diff(((issue.get('description') or '') if issue else '').splitlines(True), body.splitlines(True), fromfile='current', tofile='proposed'))})
    payload = {'schema_version': 1, 'sync_script_sha256': engine_hash(), 'target': TARGET, 'proposal': proposal, 'report_sha256': hashlib.sha256(report.encode()).hexdigest(), 'operations': operations}
    return {'payload': payload, 'sha256': digest(payload)}


def summary(plan):
    lines = ['# Pitchroom review synchronization preview', '', f"Approval digest: `{plan['sha256']}`", '', 'No remote writes have been made. Approval applies only to this exact preview.', '', '| Task | Action | Existing issue | Priority | Start gate |', '|---|---|---|---|---|']
    lines += [f"| {op['key']} | {op['kind']} | {op['identifier'] or 'new'} | {op.get('field_changes', {}).get('priority', 'unchanged')} | {(op.get('start_gate') or {}).get('verdict', 'not assessed')} |" for op in plan['payload']['operations']]
    for op in plan['payload']['operations']:
        if op['kind'] != 'unchanged':
            lines += ['', f"## {op['key']} ({op['kind']})", '', '```diff', op['diff'], '```']
    lines += ['', '## Coverage and deferrals', ''] + [f"- {item['id']}: {item['disposition']}. {item['reason']}" for item in plan['payload']['proposal']['coverage']]
    return '\n'.join(lines) + '\n'


def apply(plan, approval, report, cli, journal_path):
    payload = plan['payload']
    if approval != plan['sha256'] or digest(payload) != approval or payload['target'] != TARGET or payload['sync_script_sha256'] != engine_hash():
        raise ValueError('Exact preview approval digest required; do not generate approval without human confirmation')
    if hashlib.sha256(report.encode()).hexdigest() != payload['report_sha256']:
        raise ValueError('Review changed after preview')
    validate(payload['proposal'], report)
    if any(op['kind'] == 'conflict' for op in payload['operations']):
        raise ValueError('Conflicted preview cannot be applied')
    journal_path = Path(journal_path)
    with Path(str(journal_path) + '.lock').open('a') as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        journal = read(journal_path) if journal_path.exists() else {'preview_sha256': approval, 'completed': {}, 'uncertain': None}
        if journal['preview_sha256'] != approval:
            raise ValueError('Journal belongs to another preview')
        if journal['uncertain']:
            raise ValueError('Prior command outcome uncertain; inspect Multica and regenerate preview, no blind retry')
        inventory = cli.issues()
        for op in payload['operations']:
            if op['key'] in journal['completed']:
                current = cli.get(journal['completed'][op['key']]['id'])
                if digest(snapshot(current)) != journal['completed'][op['key']]['after_sha256']:
                    raise ValueError('Completed task changed after partial sync; regenerate preview')
            elif op['issue_id'] and snapshot(cli.get(op['issue_id'])) != op['before']:
                raise ValueError('Issue changed after preview; no overwrite')
            if op['issue_id'] and digest(cli.call(['issue', 'runs', op['issue_id']])) != op['before_runs_sha256']:
                raise ValueError('Execution history changed after preview')
            if not op['issue_id'] and op['key'] not in journal['completed'] and any(marker(op['key'])[0] in (issue.get('description') or '') or normalized_title(issue['title']) == normalized_title(op['title']) for issue in inventory):
                raise ValueError('New duplicate appeared after preview')
        for op in payload['operations']:
            if op['kind'] == 'unchanged' or op['key'] in journal['completed']:
                continue
            if op['issue_id'] and snapshot(cli.get(op['issue_id'])) != op['before']:
                raise ValueError('Issue changed immediately before write')
            body_path = journal_path.parent / f"{op['key']}.description.md"
            body_path.write_text(op['description'])
            if not body_path.resolve().is_relative_to(Path.cwd().resolve()):
                raise ValueError('Description file must be within working directory')
            journal['uncertain'] = op['key']
            write(journal_path, journal)
            if op['kind'] == 'create':
                args = ['issue', 'create', '--project', TARGET['project'], '--title', op['title'], '--description-file', str(body_path.resolve()), '--status', 'backlog']
                if 'priority' in op.get('field_changes', {}):
                    args += ['--priority', op['field_changes']['priority']['after']]
                issue = unwrap(cli.call(args))
            else:
                args = ['issue', 'update', op['issue_id'], '--description-file', str(body_path.resolve()), '--no-start']
                if 'priority' in op.get('field_changes', {}):
                    args += ['--priority', op['field_changes']['priority']['after']]
                cli.raw(args)
                issue = cli.get(op['issue_id'])
            if issue['status'] != 'backlog' or issue.get('assignee_id') or issue['description'] != op['description']:
                raise ValueError('Post-write invariant failed; stop and inspect')
            if op['before']:
                expected = {**op['before'], 'description': op['description']}
                if 'priority' in op.get('field_changes', {}):
                    expected['priority'] = op['field_changes']['priority']['after']
                if snapshot(issue) != expected:
                    raise ValueError('Unexpected field mutation after write')
            runs = cli.call(['issue', 'runs', issue['id']])
            if digest(runs) != op['before_runs_sha256']:
                raise ValueError('New execution history after write; stop, do not cancel anything automatically')
            journal['completed'][op['key']] = {'id': issue['id'], 'after_sha256': digest(snapshot(issue))}
            journal['uncertain'] = None
            write(journal_path, journal)
    return journal


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--profile')
    sub = parser.add_subparsers(dest='mode', required=True)
    p = sub.add_parser('preview')
    p.add_argument('--proposal', required=True)
    p.add_argument('--out', required=True)
    p = sub.add_parser('check-ready')
    p.add_argument('--proposal', required=True)
    p.add_argument('--task', required=True)
    p = sub.add_parser('apply')
    p.add_argument('--preview', required=True)
    p.add_argument('--approve-sha256', required=True)
    p.add_argument('--journal', required=True)
    args = parser.parse_args()
    cli = CLI(args.profile)
    cli.check()
    if args.mode == 'preview':
        proposal = read(args.proposal)
        report = Path(proposal['review_path']).read_text()
        inventory = cli.issues()
        validate(proposal, report)
        preliminary = preview(proposal, report, inventory)
        runs = {op['issue_id']: cli.call(['issue', 'runs', op['issue_id']]) for op in preliminary['payload']['operations'] if op['issue_id']}
        plan = preview(proposal, report, inventory, runs)
        out = Path(args.out)
        if out.exists() or out.with_suffix('.md').exists():
            raise ValueError('Preview artifacts are immutable; use a new output name')
        write(out, plan)
        out.with_suffix('.md').write_text(summary(plan))
        print(json.dumps({'preview': str(out), 'sha256': plan['sha256'], 'counts': {kind: sum(op['kind'] == kind for op in plan['payload']['operations']) for kind in ['create', 'update', 'unchanged', 'conflict']}, 'remote_writes': 0}))
    elif args.mode == 'check-ready':
        proposal = read(args.proposal)
        validate(proposal, Path(proposal['review_path']).read_text())
        if proposal['schema_version'] != 2:
            raise ValueError('Start gate requires proposal schema v2')
        inventory = cli.issues()
        check_dependencies(proposal, inventory)
        task = next(t for t in proposal['tasks'] if t['key'] == args.task or t.get('match_issue') == args.task)
        gate = readiness(task, inventory)
        print(json.dumps(gate))
        if gate['verdict'] != 'ready_for_reviewed_execution':
            raise SystemExit(2)
    else:
        plan = read(args.preview)
        report = Path(plan['payload']['proposal']['review_path']).read_text()
        result = apply(plan, args.approve_sha256, report, cli, args.journal)
        print(json.dumps({'completed': len(result['completed']), 'uncertain': result['uncertain']}))


if __name__ == '__main__':
    try:
        main()
    except (ValueError, RuntimeError, subprocess.TimeoutExpired, BlockingIOError) as error:
        raise SystemExit(safe_error(str(error)))
