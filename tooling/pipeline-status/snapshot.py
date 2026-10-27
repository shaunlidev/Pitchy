#!/usr/bin/env python3
"""Read-only task JSON. Offline by default; --live reads existing CLI observations.

Usage: python3 -B tooling/pipeline-status/snapshot.py [--live] [--issue PIT-61]
GitHub metadata is usable for 120 seconds. A pass describes observed CI only,
never review, merge authorization, product acceptance or deployment readiness.
"""
import argparse
from datetime import datetime, timezone
import json
import re
import subprocess
import time

MAX_AGE_SECONDS = 120
FIELDS = ('schema_version', 'live_checked', 'observed_at', 'issue', 'stage',
          'owner', 'branch', 'pr', 'head', 'ci', 'blocked_reasons',
          'next_action', 'human_decision_required', 'passed')
STAGES = {'backlog', 'todo', 'in_progress', 'started_2', 'started_3',
          'in_review', 'blocked', 'done', 'cancelled'}
CI_STATES = {'success', 'failure', 'pending', 'missing', 'cancelled',
             'skipped', 'timed_out', 'incomplete', 'unknown'}


def read_issue(key):
    result = subprocess.run(['multica', 'issue', 'get', key, '--output', 'json'],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('unavailable')
    return json.loads(result.stdout)


def read_pr(number):
    result = subprocess.run(['gh', 'pr', 'view', str(number), '--repo',
                             'shaunlidev/pitchroom', '--json',
                             'number,headRefName,headRefOid,baseRefName,state'],
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise ValueError('unavailable')
    return json.loads(result.stdout)


def identity(value):
    return value if isinstance(value, str) and re.fullmatch(
        r'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}', value) else None


def sha(value):
    return value if isinstance(value, str) and re.fullmatch(r'[0-9a-f]{40}', value) else None


def snapshot(key='PIT-61', live=False, reader=read_issue, now=None, pr_reader=read_pr):
    if not re.fullmatch(r'PIT-[1-9][0-9]*', key):
        raise ValueError('Invalid issue key')
    started = time.monotonic()
    now = now or datetime.now(timezone.utc)
    result = dict(zip(FIELDS, (1, False, None, key, None, None, None, None,
                              None, 'unknown', [], 'request_live_snapshot', None, False)))
    gaps = result['blocked_reasons']
    if not live:
        gaps.append('not_connected')
        return result
    try:
        issue = reader(key)
        if not isinstance(issue, dict) or issue.get('identifier') != key:
            raise ValueError('invalid issue')
        result['live_checked'] = True
        stage = issue.get('status')
        result['stage'] = stage if isinstance(stage, str) and stage in STAGES else None
        result['owner'] = identity(issue.get('assignee_id'))
        result['human_decision_required'] = result['stage'] in {'in_review', 'blocked'}
        if result['stage'] is None:
            gaps.append('stage_missing')
        if result['owner'] is None:
            gaps.append('owner_missing')
        if stage == 'blocked':
            gaps.append('task_blocked')
        meta = issue.get('metadata')
        if not isinstance(meta, dict):
            raise ValueError('missing metadata')
        observed = datetime.fromisoformat(meta['github_sync_observed_at'].replace('Z', '+00:00'))
        if observed.tzinfo is None:
            raise ValueError('missing timezone')
        result['observed_at'] = observed.astimezone(timezone.utc).isoformat()
        age = (now - observed).total_seconds()
        if not 0 <= age <= MAX_AGE_SECONDS:
            gaps.append('observation_expired')
        if meta.get('github_sync_state') != 'fresh':
            gaps.append('observation_unavailable')
        prs = meta.get('github_prs')
        prs = json.loads(prs) if isinstance(prs, str) else prs
        if not isinstance(prs, list) or len(prs) != 1 or not isinstance(prs[0], dict):
            raise ValueError('ambiguous PR')
        pr = prs[0]
        number = pr.get('number')
        result['pr'] = number if type(number) is int and number > 0 else None
        result['head'] = sha(pr.get('head'))
        current = pr_reader(number) if result['pr'] else {}
        if (current.get('number') != number or current.get('headRefOid') != result['head']
                or current.get('baseRefName') != pr.get('base')
                or current.get('state') != 'OPEN'):
            gaps.append('pr_changed_or_unavailable')
        branch = current.get('headRefName')
        if isinstance(branch, str) and re.fullmatch(r'codex/pit-' + key[4:] + r'-[a-z0-9-]+', branch):
            result['branch'] = branch
        else:
            gaps.append('branch_missing')
        if result['pr'] is None or result['head'] is None:
            gaps.append('version_missing')
        ci = pr.get('ci')
        if not isinstance(ci, dict) or sha(ci.get('sha')) is None or ci.get('sha') != result['head']:
            gaps.append('ci_head_mismatch')
        else:
            state = ci.get('state')
            result['ci'] = state if isinstance(state, str) and state in CI_STATES else 'unknown'
        if result['ci'] != 'success':
            gaps.append('ci_not_successful')
        if pr.get('base') != 'main' or pr.get('state') not in {'DRAFT', 'OPEN'}:
            gaps.append('pr_not_active_on_main')
    except (ValueError, KeyError, TypeError, AttributeError, OSError, subprocess.SubprocessError):
        gaps.append('read_unavailable_or_invalid')
    if result['observed_at'] is not None:
        observed = datetime.fromisoformat(result['observed_at'])
        if (now - observed).total_seconds() + time.monotonic() - started > MAX_AGE_SECONDS:
            if 'observation_expired' not in gaps:
                gaps.append('observation_expired')
    result['passed'] = not gaps
    result['next_action'] = ('resolve_observation_or_task_hold' if gaps else
                             'await_human_decision' if result['human_decision_required'] else
                             'await_serial_scheduler')
    return result


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--live', action='store_true')
    parser.add_argument('--issue', default='PIT-61', type=lambda s: s if re.fullmatch(r'PIT-[1-9][0-9]*', s) else parser.error('Invalid issue key'))
    args = parser.parse_args()
    result = snapshot(args.issue, args.live)
    print(json.dumps(result, ensure_ascii=False, sort_keys=True))
    return 2 if args.live and not result['passed'] else 0


if __name__ == '__main__':
    raise SystemExit(main())
