#!/usr/bin/env python3
"""Validated pipeline configuration and read-only canonical operational view."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
import subprocess
import time

ROOT = Path(__file__).resolve().parents[2]
CONTROL_MODES = {'open', 'admission_paused', 'maintenance'}
FINGERPRINT_FILES = ('serial.py', 'controller.py', 'acceptance.py', 'artifacts.py',
                     'github_sync.py', 'status.py', 'runtime.json', 'policy.json')
PHASES = {'developer', 'reviewer', 'qa', 'supplemental', 'awaiting_role_exit', 'awaiting_merge', 'done', 'held'}
RUNNING = {'queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'}
TERMINAL = {'completed', 'failed', 'cancelled'}
TRACKER = {'backlog', 'todo', 'in_progress', 'started_2', 'started_3', 'in_review', 'blocked', 'done', 'cancelled'}
CI = {'success', 'failure', 'pending', 'missing', 'cancelled', 'skipped', 'timed_out', 'incomplete', 'unknown'}


def object_file(path):
    value = json.loads(Path(path).read_text())
    if not isinstance(value, dict):
        raise ValueError('Expected object')
    return value


def load_config(root):
    """Policy owns invariants; runtime owns machine identities and task routing."""
    root = Path(root)
    policy = object_file(root / 'tooling/pipeline/policy.json')
    runtime = object_file(root / 'tooling/pipeline/runtime.json')
    fixed = {'schema_version': 1, 'default_base': 'main', 'mode': 'serial_polling',
             'task_lanes': 1, 'machine_cap': 5, 'merge_policy': 'human_approved_squash',
             'engineering_done_requires': ['merged', 'post_merge_checks_passed'],
             'automatic_handoff': True, 'automatic_done': True, 'automatic_deployment': False,
             'activation': 'explicit_verified_local_receipt', 'required_ci_check': 'PR gate',
             'dispatch_control_default': 'admission_paused', 'max_observation_seconds': 120}
    for key, expected in fixed.items():
        if type(policy.get(key)) is not type(expected) or policy[key] != expected:
            raise ValueError('Unsupported policy: ' + key)
    if not isinstance(policy.get('repository'), str) or not re.fullmatch(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+', policy['repository']):
        raise ValueError('Invalid repository')
    if identity(policy.get('project_id')) is None:
        raise ValueError('Invalid project')
    aliases = {'project': 'project_id', 'max_lanes': 'task_lanes'}
    for key, value in runtime.items():
        owner = aliases.get(key, key)
        if owner in policy:
            raise ValueError('Duplicate runtime policy: ' + key)
    # Unknown policy switches must not be accepted as effective controls.
    if set(policy) != set(fixed) | {'repository', 'project_id'}:
        raise ValueError('Unknown policy field')
    allowed = {'profile', 'workspace', 'developer', 'reviewer', 'qa', 'dispatcher', 'owner',
               'autopilot', 'optional_roles', 'review_status', 'qa_status', 'order', 'legacy_dependencies', 'decision_holds'}
    if set(runtime) - allowed - set(policy) - set(aliases):
        raise ValueError('Unknown runtime field')
    for key in ('workspace', 'developer', 'reviewer', 'qa', 'dispatcher', 'owner', 'autopilot'):
        if identity(runtime.get(key)) is None:
            raise ValueError('Invalid runtime identity: ' + key)
    if len({runtime[r] for r in ('developer', 'reviewer', 'qa')}) != 3:
        raise ValueError('Roles must be independent')
    options = runtime.get('optional_roles')
    if not isinstance(options, dict) or set(options) != {'small_tasks_enabled', 'small_tasks_agent', 'supplemental_enabled', 'supplemental_agent'}:
        raise ValueError('Invalid optional role configuration')
    if any(type(options[k]) is not bool for k in ('small_tasks_enabled', 'supplemental_enabled')):
        raise ValueError('Invalid optional role switch')
    optional_actors = [options.get(k) for k in ('small_tasks_agent', 'supplemental_agent')]
    if any(identity(a) is None for a in optional_actors) or len(set(optional_actors + [runtime[r] for r in ('developer','reviewer','qa')])) != 5:
        raise ValueError('Optional role actors must be distinct identities')
    if runtime.get('review_status') != 'started_2' or runtime.get('qa_status') != 'started_3':
        raise ValueError('Invalid role status')
    if not isinstance(runtime.get('profile'), str) or not re.fullmatch(r'[\w-]+', runtime['profile']):
        raise ValueError('Invalid profile')
    if not isinstance(runtime.get('order'), list) or not all(issue_key(k) for k in runtime['order']):
        raise ValueError('Invalid task order')
    for name in ('legacy_dependencies', 'decision_holds'):
        if not isinstance(runtime.get(name), dict) or not all(issue_key(k) for k in runtime[name]):
            raise ValueError('Invalid routing configuration')
    if not all(sha(v) for v in runtime['legacy_dependencies'].values()):
        raise ValueError('Invalid dependency identity')
    return policy, {**runtime, 'project': policy['project_id'], 'max_lanes': policy['task_lanes'],
                    'machine_cap': policy['machine_cap'], 'repository': str(root)}


def fingerprint(root):
    digest = hashlib.sha256()
    for name in FINGERPRINT_FILES:
        digest.update(name.encode() + b'\0' + (Path(root) / 'tooling/pipeline' / name).read_bytes())
    return digest.hexdigest()


def activation_state(root, state):
    try:
        value = object_file(Path(state) / 'activation.json')
        valid = (value.get('source_fingerprint') == fingerprint(root)
                 and value.get('verified') is True and type(value.get('task_lanes')) is int
                 and value['task_lanes'] == 1 and sha(value.get('integrated_commit')) is not None)
        return {'state': 'valid' if valid else 'stale', 'integrated_commit': sha(value.get('integrated_commit'))}
    except FileNotFoundError:
        return {'state': 'missing', 'integrated_commit': None}
    except (OSError, ValueError, TypeError):
        return {'state': 'invalid', 'integrated_commit': None}


def control_state(root, state, policy):
    path = Path(state) / 'control.json'
    if not path.exists():
        return {'mode': policy['dispatch_control_default'], 'source': 'safe_default', 'valid': True}
    try:
        value = object_file(path)
        if value.get('mode') not in CONTROL_MODES or value.get('source_fingerprint') != fingerprint(root):
            raise ValueError('Invalid/stale control')
        return {'mode': value['mode'], 'source': 'operator', 'valid': True}
    except (OSError, ValueError, TypeError):
        return {'mode': 'maintenance', 'source': 'invalid_or_stale_control', 'valid': False}


def identity(value):
    return value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}', value) else None


def sha(value):
    return value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) else None


def issue_key(value):
    return value if isinstance(value, str) and re.fullmatch(r'PIT-[1-9][0-9]*', value) else None


def age_seconds(value, now):
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            return None
        age = (now - dt).total_seconds()
        return round(age, 2) if age >= 0 else None
    except (AttributeError, ValueError, TypeError):
        return None


def read_json(argv, cwd=ROOT):
    result = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=45)
    if result.returncode:
        raise ValueError('Read unavailable')
    return json.loads(result.stdout)


def read_ledger(state):
    """Do not instantiate Controller: its constructor creates/mutates the ledger."""
    path = Path(state) / 'ledger.sqlite3'
    # Reject WAL rather than opening/creating shared memory files in a read-only view.
    if path.with_name(path.name + '-wal').exists():
        raise ValueError('WAL observation requires reconciliation')
    # Immutable memory copy avoids SQLite journal/SHM writes, including a concurrent writer.
    before = path.stat()
    data = path.read_bytes()
    after = path.stat()
    if (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size) or path.with_name(path.name + '-wal').exists():
        raise ValueError('Ledger changed during read')
    db = sqlite3.connect(':memory:')
    try:
        db.deserialize(data)
        db.execute('PRAGMA query_only=ON')
        lanes = {key: json.loads(value) for key, value in db.execute('SELECT issue,data FROM lanes')}
        if any(not issue_key(k) or not isinstance(v, dict) or v.get('issue') != k for k, v in lanes.items()):
            raise ValueError('Invalid ledger')
        uncertain = db.execute("SELECT count(*) FROM operations WHERE state='uncertain'").fetchone()[0]
        return lanes, uncertain
    finally:
        db.close()


def role_result(lane, role, config, head):
    record = lane.get('receipts', {}).get(role, {})
    artifact = lane.get('artifact', {})
    valid = bool(head and record.get('issue') == lane.get('issue') and artifact.get('issue') == lane.get('issue')
                 and type(lane.get('generation')) is int and lane['generation'] > 0
                 and record.get('commit') == head and record.get('tree') == artifact.get('tree')
                 and sha(artifact.get('tree')) and record.get('generation') == lane.get('generation')
                 and record.get('contract_sha256') and record.get('contract_sha256') == artifact.get('contract_sha256')
                 and record.get('description_sha256') == artifact.get('description_sha256') == lane.get('description_sha256')
                 and record.get('actor_id') == config[role] and record.get('role') == role
                 and identity(record.get('run_id')) and record.get('dirty') is False)
    passed = (valid and record.get('outcome') == 'pass'
              and not any(record.get(k) for k in ('gaps', 'decisions', 'failures', 'skipped', 'not_run'))
              and (role != 'reviewer' or record.get('complete_contract_review') is True))
    return {'state': 'pass' if passed else 'unknown', 'head': sha(record.get('commit')),
            'run_id': identity(record.get('run_id'))}


def task_view(key, lane, issue, runs, pr, config, fresh):
    lane, issue = lane or {}, issue or {}
    artifact = lane.get('artifact', {})
    recorded_head = sha(artifact.get('commit'))
    current_head = sha(pr.get('head')) if pr else None
    head = current_head or recorded_head
    phase = lane.get('phase') if lane.get('phase') in PHASES else None
    tracker = issue.get('status') if issue.get('status') in TRACKER else None
    gaps = []
    valid_runs = isinstance(runs, list) and all(isinstance(r, dict) and identity(r.get('id'))
        and identity(r.get('agent_id')) and identity(issue.get('id')) and r.get('issue_id') == issue.get('id')
        and r.get('status') in RUNNING | TERMINAL for r in runs)
    valid_runs = valid_runs and len({r['id'] for r in runs}) == len(runs)
    active = [{k: r.get(k) for k in ('id', 'agent_id', 'status')} for r in runs if r['status'] in RUNNING] if valid_runs else []
    actors = {r: config[r] for r in ('developer', 'reviewer', 'qa')}
    metadata = issue.get('metadata', {})
    route, supplement = metadata.get('developer_route', 'default'), metadata.get('supplemental_review', 'off')
    options = config.get('optional_roles', {})
    routing_valid = route in {'default', 'small'} and supplement in {'off', 'on'}
    if route == 'small':
        routing_valid = routing_valid and options.get('small_tasks_enabled') is True
        actors['developer'] = options.get('small_tasks_agent')
    if supplement == 'on':
        routing_valid = routing_valid and options.get('supplemental_enabled') is True
        actors['supplemental'] = options.get('supplemental_agent')
    expected_routing = {'developer_route':route, 'supplemental_review':supplement, 'actors':actors}
    if lane:
        routing_valid = routing_valid and (lane.get('routing') == expected_routing if 'routing' in lane else route == 'default' and supplement == 'off')
    if not routing_valid: gaps.append('routing_changed_or_disabled')
    for run in active:
        run['role'] = next((r for r, actor in actors.items() if actor == run['agent_id']), 'unknown') if routing_valid else 'unknown'
    if not fresh: gaps.append('live_observation_unavailable_or_stale')
    if not valid_runs: gaps.append('runtime_unknown')
    if tracker in {'todo', 'in_progress', 'started_2', 'started_3'} and valid_runs and not active:
        gaps.append('tracker_active_without_runtime')
    if phase is None: gaps.append('not_controlled_or_phase_unknown')
    if lane:
        if lane.get('id') != issue.get('id') or lane.get('issue') != key or issue.get('identifier') != key:
            gaps.append('task_identity_mismatch')
        description = issue.get('description')
        if not isinstance(description, str) or hashlib.sha256(description.encode()).hexdigest() != lane.get('description_sha256'):
            gaps.append('contract_description_changed_or_unknown')
    if tracker is None: gaps.append('tracker_unknown')
    if tracker == 'blocked': gaps.append('tracker_hold')
    if tracker == 'cancelled': gaps.append('tracker_cancelled')
    if phase == 'awaiting_merge' and tracker not in {'in_review', 'blocked', 'cancelled', None}:
        gaps.append('tracker_phase_mismatch')
    if active and phase in {'awaiting_merge', 'done'}: gaps.append('runtime_phase_conflict')
    if pr and pr.get('base') != 'main': gaps.append('pr_base_mismatch')
    if not head: gaps.append('head_unknown')
    if current_head and recorded_head and current_head != recorded_head: gaps.append('head_changed')
    ci = pr.get('ci', {}) if pr else {}
    ci_state = ci.get('state') if fresh and head and ci.get('sha') == head and ci.get('state') in CI else 'unknown'
    roles = {r: role_result(lane, r, config, head) for r in ('reviewer', 'qa')}
    for role, result in roles.items():
        if not fresh or not valid_runs or not any(r['id'] == result['run_id'] and r['agent_id'] == config[role] and r['status'] == 'completed' for r in (runs or [])):
            result['state'] = 'unknown'
    integration = lane.get('integration', {})
    merge = sha(pr.get('merge_sha')) if pr else None
    check = pr.get('integration_ci', {}) if pr else {}
    integration_ci = check.get('state') if fresh and merge and check.get('sha') == merge and check.get('state') in CI else 'unknown'
    done = bool(fresh and tracker == 'done' and phase == 'done' and current_head == recorded_head
                and head and merge and integration.get('head') == head and integration.get('commit') == merge
                and integration.get('method') == 'squash' and sha(integration.get('parent'))
                and integration.get('tree') == artifact.get('tree') and pr.get('state') == 'MERGED'
                and ci_state == 'success' and integration_ci == 'success' and all(r['state'] == 'pass' for r in roles.values()) and not gaps)
    ready = bool(not gaps and tracker == 'in_review' and phase == 'awaiting_merge' and pr and pr.get('state') in {'OPEN', 'DRAFT'}
                 and ci_state == 'success' and all(r['state'] == 'pass' for r in roles.values()))
    if pr and pr.get('state') == 'MERGED' and not done: gaps.append('integration_not_verified')
    if phase == 'held': gaps.append('controller_hold')
    if ci_state != 'success': gaps.append('ci_' + ci_state)
    human = True if ready or phase == 'held' or tracker == 'blocked' else None if gaps else False
    action = ('engineering_complete' if done else 'request_exact_head_merge_approval' if ready else
              'inspect_hold' if gaps else 'await_running_role' if active else 'await_serial_handoff')
    branch = lane.get('branch')
    if not isinstance(branch, str) or not re.fullmatch(r'codex/[A-Za-z0-9_./-]+', branch): branch = None
    return {'issue': key, 'tracker_status': tracker, 'controller_phase': phase,
            'routing': {'developer_route':route, 'supplemental_review':supplement, 'valid':routing_valid},
            'owner': identity(issue.get('assignee_id')), 'active_runs': active, 'runtime_known': valid_runs and fresh,
            'branch': branch, 'pr': pr.get('number') if pr and type(pr.get('number')) is int else lane.get('pr_number') if type(lane.get('pr_number')) is int else None,
            'head': head, 'recorded_head': recorded_head, 'ci': ci_state, 'roles': roles,
            'merge_commit': merge or sha(integration.get('commit')), 'integration_ci': integration_ci,
            'engineering_done': done, 'ready_to_merge': ready, 'blocked_reasons': gaps,
            'next_action': action, 'human_decision_required': human,
            'product_acceptance': 'unknown', 'deployment': 'unknown'}


def snapshot(live=False, legacy_root=None, root=ROOT, state=None, reader=read_json, now=None, key=None):
    started = time.monotonic()
    now = now or datetime.now(timezone.utc)
    result = {'schema_version': 2, 'live_checked': False, 'errors': [], 'tasks': []}
    try:
        policy, config = load_config(root)
    except (OSError, ValueError, TypeError):
        return {**result, 'errors': ['configuration_invalid'], 'next_action': 'repair_configuration'}
    result['policy'] = policy
    result['optional_roles'] = {k: config['optional_roles'][k] for k in ('small_tasks_enabled', 'supplemental_enabled')}
    if state is None:
        try:
            common = subprocess.check_output(['git', 'rev-parse', '--path-format=absolute', '--git-common-dir'], cwd=root, text=True).strip()
            canonical = Path(common).parent
            if Path(root).resolve() != canonical.resolve():
                result['errors'].append('task_copy_not_active_source')
            state = canonical / '.state/pipeline'
        except (OSError, subprocess.SubprocessError):
            return {**result, 'errors': ['canonical_repository_unavailable']}
    result['activation'] = activation_state(root, state)
    result['control'] = control_state(root, state, policy)
    try:
        lanes, uncertain = read_ledger(state)
    except (OSError, ValueError, TypeError, sqlite3.Error):
        lanes, uncertain = {}, None
        result['errors'].append('ledger_unavailable_or_invalid')
    result['uncertain_operations'] = uncertain
    try:
        health = object_file(Path(state) / 'sync-health.json')
        age = age_seconds(health.get('observed_at'), now)
        result['poll'] = {'age_seconds': age, 'state': 'fresh' if health.get('state') == 'fresh' and age is not None and age <= policy['max_observation_seconds'] else 'unavailable_or_stale',
                          'error_present': bool(health.get('error'))}
    except (OSError, ValueError, TypeError):
        result['poll'] = {'age_seconds': None, 'state': 'unknown', 'error_present': True}
    if legacy_root:
        try:
            if any(object_file(Path(legacy_root) / 'tooling/multica-pipeline' / n).get('enabled') is not False for n in ('config.json', 'config-v2.json')):
                result['errors'].append('legacy_dispatch_not_disabled')
        except (OSError, ValueError, TypeError):
            result['errors'].append('legacy_dispatch_unknown')
    issues, runs, prs = {}, {}, {}
    scheduler = 'unknown'
    if live:
        from github_sync import GitHub, all_issues, mapping
        def call(args):
            return reader(['multica', '--profile', config['profile'], '--workspace-id', config['workspace'], *args])
        try:
            issues = {i['identifier']: i for i in all_issues(call, config['project'])}
            pilots = call(['autopilot', 'list', '--output', 'json'])['autopilots']
            matches = [p for p in pilots if p.get('id') == config['autopilot'] and p.get('project_id') == config['project']]
            if len(matches) != 1 or matches[0].get('status') not in {'active', 'paused'}:
                raise ValueError('Scheduler unknown')
            scheduler = matches[0]['status']
        except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
            result['errors'].append('tracker_or_scheduler_unavailable')
        github = GitHub(policy['repository'], execute=reader)
        selected = {key} if key else set(lanes) | {k for k, i in issues.items() if i.get('status') in {'todo', 'in_progress', 'started_2', 'started_3', 'in_review', 'blocked'}}
        for item in sorted(selected):
            try:
                if item not in issues: raise ValueError('Missing tracker issue')
                runs[item] = call(['issue', 'runs', item, '--output', 'json'])
                number = lanes.get(item, {}).get('pr_number')
                if number is None:
                    candidate = str(issues[item].get('metadata', {}).get('pr_number', ''))
                    number = int(candidate) if re.fullmatch(r'[1-9][0-9]{0,9}', candidate) else None
                if type(number) is int and number > 0:
                    raw = github.api('pulls/' + str(number))
                    if item not in lanes and not mapping([issues[item]], [raw], policy['repository']).get(item):
                        raise ValueError('Unassociated manual PR')
                    prs[item] = github.snapshot(raw)
            except (OSError, ValueError, KeyError, TypeError, subprocess.SubprocessError):
                result['errors'].append(item + ':live_read_unavailable')
    else:
        selected = {key} if key else set(lanes)
    fresh = live and not result['errors'] and time.monotonic() - started <= policy['max_observation_seconds']
    if live and time.monotonic() - started > policy['max_observation_seconds']:
        result['errors'].append('live_observation_expired')
    result['live_checked'] = fresh
    result['scheduler'] = {'status': scheduler, 'new_admission': bool(fresh and scheduler == 'active'
        and result['activation']['state'] == 'valid' and result['control']['mode'] == 'open' and uncertain == 0),
        'handoffs': bool(fresh and scheduler == 'active' and result['activation']['state'] == 'valid'
            and result['control']['mode'] != 'maintenance' and uncertain == 0)}
    for item in sorted(selected):
        try:
            row = task_view(item, lanes.get(item), issues.get(item), runs.get(item), prs.get(item), config, fresh)
        except (AttributeError, ValueError, TypeError, KeyError):
            row = {'issue': item, 'engineering_done': False, 'ready_to_merge': False, 'blocked_reasons': ['invalid_evidence'], 'next_action': 'inspect_hold', 'human_decision_required': None}
            result['errors'].append(item + ':invalid_evidence')
        result['tasks'].append(row)
    if result['errors']:
        result['live_checked'] = False
        result['scheduler'].update(new_admission=False, handoffs=False)
        for row in result['tasks']:
            row.update(engineering_done=False, ready_to_merge=False, next_action='inspect_hold')
            row.setdefault('blocked_reasons', []).append('snapshot_incomplete')
            for role in row.get('roles', {}).values(): role['state'] = 'unknown'

    return result


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--issue', type=lambda value: issue_key(value) or parser.error('Invalid issue'))
    parser.add_argument('--legacy-root', type=Path)
    args = parser.parse_args()
    output = snapshot(args.live, args.legacy_root, key=args.issue)
    print(json.dumps(output, ensure_ascii=False, indent=2))
    raise SystemExit(2 if output['errors'] else 0)
