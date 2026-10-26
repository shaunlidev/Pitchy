#!/usr/bin/env python3
"""Read-only local policy and optional live Multica/GitHub reconciliation."""
import argparse
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def read_json(argv, cwd=ROOT):
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise RuntimeError('Read failed: ' + ' '.join(argv[:3]))
    return json.loads(result.stdout)


def reconcile(policy, prs, autopilots, resources, linked):
    findings = []
    if policy.get('mode') != 'serial_polling' and any(x.get('status') == 'active' for x in autopilots):
        findings.append('Scheduled dispatch is active; foundation policy requires paused dispatch.')
    if not any(x.get('resource_ref', {}).get('execution_mode') == 'worktree' for x in resources):
        findings.append('Multica has no worktree resource.')
    for pr in prs:
        if pr['state'] != 'OPEN':
            continue
        checks = pr.get('statusCheckRollup') or []
        gate = [x for x in checks if x.get('name') == policy['required_ci_check']]
        if not gate or any(x.get('conclusion') != 'SUCCESS' for x in gate):
            findings.append(f"PR #{pr['number']}: required current-head CI gate not successful.")
        if pr['number'] in policy.get('migration_prs', []) and pr['number'] != 1 and pr['baseRefName'] != policy['migration_base']:
            findings.append(f"PR #{pr['number']}: migration base changed; revalidate integration.")
    for issue, data in linked.items():
        if not data.get('pull_requests'):
            findings.append(f'{issue}: native Multica PR association missing.')
    return findings


def snapshot(live=False, legacy_root=None):
    policy = json.loads((ROOT / 'tooling/pipeline/policy.json').read_text())
    result = {'policy': policy, 'live_checked': False, 'errors': [], 'findings': []}
    common = Path(subprocess.check_output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=ROOT, text=True).strip()).parent
    activation = common / '.state/pipeline/activation.json'
    result['runtime_activation_present'] = activation.exists()
    result['local_head'] = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    if legacy_root:
        for name in ('config.json', 'config-v2.json'):
            config = json.loads((legacy_root / 'tooling/multica-pipeline' / name).read_text())
            if config.get('enabled'):
                result['findings'].append(f'Legacy {name} enables dispatch; keep disabled.')
    if not live:
        result['findings'].append('Live systems not queried; local policy is not proof of live state.')
        return result
    queries = {
        'prs': ['gh', 'pr', 'list', '--repo', policy['repository'], '--state', 'all', '--limit', '100', '--json', 'number,title,state,isDraft,headRefName,baseRefName,headRefOid,mergedAt,statusCheckRollup,url'],
        'autopilots': ['multica', 'autopilot', 'list', '--output', 'json'],
        'resources': ['multica', 'project', 'resource', 'list', policy['project_id'], '--output', 'json'],
        'agents': ['multica', 'agent', 'list', '--output', 'json'],
        'issues': ['multica', 'issue', 'list', '--project', policy['project_id'], '--limit', '100', '--output', 'json'],
        'PIT-47': ['multica', 'issue', 'pull-requests', 'PIT-47', '--output', 'json'],
        'PIT-22': ['multica', 'issue', 'pull-requests', 'PIT-22', '--output', 'json'],
    }
    data = {}
    for name, argv in queries.items():
        try:
            data[name] = read_json(argv)
        except (RuntimeError, ValueError, subprocess.TimeoutExpired, OSError):
            result['errors'].append(f'{name}: unavailable; no passing result inferred.')
    result['live_checked'] = not result['errors']
    result['prs'] = data.get('prs', [])
    result['agents'] = [{k: x.get(k) for k in ('name', 'status', 'max_concurrent_tasks')} for x in data.get('agents', [])]
    pilots = data.get('autopilots', {}).get('autopilots', [])
    pilots = [x for x in pilots if x.get('project_id') == policy['project_id']]
    result['autopilots'] = [{k: x.get(k) for k in ('title', 'status', 'last_run_at')} for x in pilots]
    issues = data.get('issues', [])
    if isinstance(issues, dict):
        issues = issues.get('issues', [])
    # No descriptions, instructions, run messages or credentials in status output.
    result['issues'] = [{k: x.get(k) for k in ('identifier', 'title', 'status', 'assignee_id', 'updated_at')} for x in issues]
    if not result['errors']:
        result['findings'] += reconcile(policy, data['prs'], pilots, data['resources'], {k: data[k] for k in ('PIT-47', 'PIT-22')})
    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--legacy-root', type=Path)
    args = parser.parse_args()
    output = snapshot(args.live, args.legacy_root)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    raise SystemExit(2 if output['errors'] else 0)
