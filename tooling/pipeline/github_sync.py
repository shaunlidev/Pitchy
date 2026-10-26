"""Domain-free, exact-head GitHub snapshots; metadata writes never wake Agents."""
import argparse
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
REQUIRED_JOBS = {'Source boundary', 'Application checks', 'PR gate'}


class SyncError(ValueError):
    pass


def cli(argv):
    if argv[0] == "multica" and "--output" not in argv:
        argv = [*argv, "--output", "json"]
    p = subprocess.run(argv, cwd=Path.cwd(), capture_output=True, text=True, timeout=90)
    if p.returncode:
        raise SyncError('CLI failed: ' + ' '.join(argv[:3]))
    try:
        return json.loads(p.stdout)
    except ValueError as e:
        raise SyncError('CLI returned invalid JSON') from e


def all_issues(call, project):
    result, seen, offset = [], set(), 0
    while True:
        data = call(['issue', 'list', '--project', project, '--limit', '100', '--offset', str(offset), '--output', 'json'])
        rows = data if isinstance(data, list) else data.get('issues')
        if not isinstance(rows, list):
            raise SyncError('Unknown issue page shape')
        for row in rows:
            if row['id'] in seen or row.get('project_id') != project:
                raise SyncError('Repeated or foreign issue page')
            seen.add(row['id']); result.append(row)
        more = isinstance(data, dict) and data.get('has_more')
        if not more and len(rows) < 100:
            return result
        if not rows or offset >= 100000:
            raise SyncError('Incomplete issue pagination')
        offset += len(rows)


class GitHub:
    def __init__(self, repository, execute=cli):
        if not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', repository):
            raise SyncError('Invalid repository')
        self.repo, self.execute, self.cache = repository, execute, {}

    def api(self, path, pages=False):
        args = ['gh', 'api', f'repos/{self.repo}/{path}']
        if pages:
            args += ['--paginate', '--slurp']
        value = self.execute(args)
        if pages:
            if not isinstance(value, list) or any(not isinstance(p, list) for p in value):
                raise SyncError('Unknown GitHub page shape')
            return [row for page in value for row in page]
        return value

    def prs(self):
        rows = self.api('pulls?state=all&per_page=100', True)
        if len({p['number'] for p in rows}) != len(rows):
            raise SyncError('Repeated PR pagination; refresh required')
        return rows

    def ci(self, sha, event):
        if not re.fullmatch(r'[0-9a-f]{40}', sha or ''):
            raise SyncError('Invalid immutable GitHub SHA')
        key = (sha, event)
        if key in self.cache:
            return self.cache[key]
        # Workflow-specific endpoint prevents an unrelated check with the same name passing.
        pages = self.execute(['gh', 'api', f'repos/{self.repo}/actions/workflows/pr-ci.yml/runs?head_sha={sha}&event={event}&per_page=100', '--paginate', '--slurp'])
        all_runs = [r for page in pages for r in page['workflow_runs']]
        runs = [x for x in all_runs if x.get('head_sha') == sha and x.get('event') == event and x.get('path', '').split('@')[0] == '.github/workflows/pr-ci.yml']
        if not runs:
            result = {'state': 'missing', 'sha': sha, 'run_id': None}
        else:
            run = max(runs, key=lambda x: (x['run_number'], x.get('run_attempt', 1), x['id']))
            state = 'pending'
            if run['status'] == 'completed':
                state = run.get('conclusion') or 'unknown'
                if state == 'success':
                    pages = self.execute(['gh', 'api', f'repos/{self.repo}/actions/runs/{run["id"]}/jobs?filter=latest&per_page=100', '--paginate', '--slurp'])
                    jobs = [j for p in pages for j in p['jobs']]
                    by_name = {j['name']: j for j in jobs}
                    if not REQUIRED_JOBS.issubset(by_name) or any(by_name[n].get('conclusion') != 'success' or by_name[n].get('status') != 'completed' for n in REQUIRED_JOBS):
                        state = 'incomplete'
            result = {'state': state, 'sha': sha, 'run_id': run['id']}
        self.cache[key] = result
        return result

    def snapshot(self, pr):
        number, head = pr['number'], pr['head']['sha']
        merged = pr.get('merged_at') is not None
        state = 'MERGED' if merged else 'CLOSED' if pr['state'] == 'closed' else 'DRAFT' if pr['draft'] else 'OPEN'
        row = {'number': number, 'url': f'https://github.com/{self.repo}/pull/{number}', 'head': head, 'base': pr['base']['ref'], 'state': state,
               'merge_sha': pr.get('merge_commit_sha') if merged else None, 'ci': self.ci(head, 'pull_request')}
        if merged:
            row['integration_ci'] = self.ci(row['merge_sha'], 'push')
        fresh = self.api(f'pulls/{number}')
        if fresh['head']['sha'] != head or fresh['state'] != pr['state'] or fresh['base']['ref'] != pr['base']['ref'] or fresh.get('merged_at') != pr.get('merged_at'):
            raise SyncError('PR changed during observation; no transition allowed')
        return row


def mapping(issues, prs, repository):
    result = {}
    for issue in issues:
        key, meta = issue['identifier'], issue.get('metadata', {})
        expression = re.compile(r'(?<![A-Za-z0-9])' + re.escape(key) + r'(?![A-Za-z0-9])', re.I)
        matched = []
        for pr in prs:
            if pr['head']['repo'] is None or pr['base']['repo']['full_name'] != repository:
                continue
            number = pr['number']
            explicit = str(meta.get('pr_number', '')) == str(number) and meta.get('pr_url') == f'https://github.com/{repository}/pull/{number}'
            if explicit or expression.search(pr['title']) or expression.search(pr['head']['ref']):
                matched.append(pr)
        if matched or meta.get('github_sync_digest'):
            result[key] = matched
    return result


def sync(policy, call, github, apply=False, now=None):
    started = time.monotonic()
    now = now or datetime.now(timezone.utc).isoformat()
    issues = all_issues(call, policy['project_id'])
    affected = [i for i in issues if i.get('metadata', {}).get('github_sync_digest')]
    try:
        prs = github.prs()
        grouped = mapping(issues, prs, policy['repository'])
        # Read all sources before publishing any passing snapshot.
        snapshots = {key: [github.snapshot(p) for p in rows] for key, rows in grouped.items()}
        if time.monotonic() - started > policy.get('max_observation_seconds', 120):
            raise SyncError('Observation expired during source reads')
        result = {'observed_at': now, 'repository': policy['repository'], 'issues': {}, 'writes': 0}
        for issue in issues:
            key, meta = issue['identifier'], issue.get('metadata', {})
            if key not in snapshots:
                continue
            rows = snapshots[key]
            payload = json.dumps(rows, sort_keys=True, separators=(',', ':'))
            digest = hashlib.sha256(payload.encode()).hexdigest()
            result['issues'][key] = {'prs': rows, 'digest': digest}
            if not apply:
                continue
            updates = {'github_sync_observed_at': now}
            publishing = meta.get('github_sync_digest') != digest or meta.get('github_sync_state') != 'fresh'
            if publishing:
                updates = {'github_sync_state': 'updating', 'github_prs': payload, 'github_sync_digest': digest, **updates}
            updates = {name:value for name,value in updates.items() if meta.get(name) != value}
            for name, value in updates.items():
                call(['issue', 'metadata', 'set', issue['id'], '--key', name, '--value', value]); result['writes'] += 1
            if publishing:
                call(['issue', 'metadata', 'set', issue['id'], '--key', 'github_sync_state', '--value', 'fresh']); result['writes'] += 1
        return result
    except (SyncError, KeyError, TypeError, ValueError, OSError, subprocess.SubprocessError):
        if apply:
            for issue in affected:
                try:
                    call(['issue', 'metadata', 'set', issue['id'], '--key', 'github_sync_state', '--value', 'unavailable'])
                except Exception:
                    pass
        raise SyncError('GitHub/Multica synchronization incomplete; no scheduling allowed') from None


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    policy = json.loads((ROOT / 'tooling/pipeline/policy.json').read_text())
    common = Path(subprocess.check_output(['git', '-C', str(ROOT), 'rev-parse', '--path-format=absolute', '--git-common-dir'], text=True).strip()).parent
    state = common / '.state/pipeline'; state.mkdir(parents=True, exist_ok=True)
    with (state / 'controller.lock').open('a') as guard:
        fcntl.flock(guard, fcntl.LOCK_EX | fcntl.LOCK_NB)
        try:
            output = sync(policy, lambda a: cli(['multica', *a]), GitHub(policy['repository']), args.apply)
            (state / 'github-latest.json').write_text(json.dumps(output, indent=2))
            print(json.dumps(output, ensure_ascii=False, indent=2))
        except SyncError as error:
            print(json.dumps({'held': str(error)})); raise SystemExit(2)
