"""Explicit human manual-delivery receipts; never enroll, merge, or schedule."""
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import tempfile
import time
from datetime import datetime, timezone

from artifacts import _text, verify_squash_merge
from controller import Hold

LIMIT = 1_000_000
SHA = re.compile(r'[a-f0-9]{40}\Z')
HASH = re.compile(r'[a-f0-9]{64}\Z')
KEY = re.compile(r'PIT-[1-9][0-9]*\Z')


def require(condition, message):
    if not condition:
        raise Hold(message)


def safe_path(path):
    path = Path(path).absolute()
    require(not any(p.is_symlink() for p in (path, *path.parents)), 'Manual evidence/receipt symlink refused')
    return path


def read_json(path):
    path = safe_path(path)
    require(path.is_file() and path.stat().st_size <= LIMIT, 'Manual evidence missing or oversized')
    raw = path.read_bytes()
    require(len(raw) <= LIMIT, 'Manual evidence oversized')
    value = json.loads(raw)
    require(isinstance(value, dict), 'Manual evidence must be an object')
    return value, hashlib.sha256(raw).hexdigest()


def ledger_clear(state, key):
    """The canonical ledger is inspected read-only, never initialized or enrolled."""
    path = safe_path(state / 'ledger.sqlite3')
    require(path.is_file(), 'Canonical ledger unavailable')
    with sqlite3.connect(path.as_uri() + '?mode=ro', uri=True) as db:
        db.execute('PRAGMA query_only=ON')
        require(not db.execute('SELECT 1 FROM lanes WHERE issue=?', (key,)).fetchone(), 'Manual issue already has a canonical lane')
        require(not db.execute("SELECT 1 FROM operations WHERE state='uncertain'").fetchone(), 'Uncertain canonical operation holds manual delivery')


def evidence(manifest_path, key, head, repository, issue):
    manifest_path = safe_path(manifest_path)
    data, manifest_hash = read_json(manifest_path)
    require(data.get('schema_version') == 1 and data.get('kind') == 'manual_delivery', 'Manual delivery manifest required')
    require(data.get('issue') == key and data.get('head') == head and data.get('repository') == repository, 'Manual delivery identity mismatch')
    require(data.get('description_sha256') == hashlib.sha256((issue.get('description') or '').encode()).hexdigest(), 'Issue contract changed')
    require(data.get('complete_contract') is True and isinstance(data.get('approval_reference'), str) and data['approval_reference'].strip(), 'Explicit operator approval and complete contract attestation required')
    criteria = data.get('criteria')
    require(isinstance(criteria, list) and criteria and all(isinstance(x, str) and x for x in criteria) and len(set(criteria)) == len(criteria), 'Complete required criteria inventory required')
    reports = data.get('reports')
    require(isinstance(reports, dict) and set(reports) == {'developer', 'reviewer', 'qa'}, 'Three role reports required')
    actors, hashes = set(), {}
    for role, entry in reports.items():
        require(isinstance(entry, dict), 'Invalid report binding')
        relative = entry.get('path')
        require(isinstance(relative, str) and relative and not Path(relative).is_absolute() and '\\' not in relative and all(x not in ('', '.', '..') for x in relative.split('/')), 'Report must be contained in manifest directory')
        report, digest = read_json(manifest_path.parent / relative)
        require(digest == entry.get('sha256') and HASH.fullmatch(digest), 'Role report hash changed')
        actor = report.get('actor')
        require(isinstance(actor, str) and actor.strip() and actor not in actors, 'Independent role identities required')
        actors.add(actor)
        require(report.get('role') == role and report.get('head') == head and report.get('issue') == key and report.get('description_sha256') == data['description_sha256'], 'Role report identity mismatch')
        require(report.get('complete_contract_review') is True and report.get('verdict') == 'pass', 'Complete passing contract review required')
        require(report.get('criterion_results') == {item: 'pass' for item in criteria}, 'All required criteria must pass')
        require(report.get('failures') == [] and report.get('not_run') == [] and report.get('decisions') == [], 'Unresolved evidence or decisions')
        checks = report.get('checks')
        require(isinstance(checks, list) and checks and all(isinstance(x, dict) and isinstance(x.get('command'), str) and x['command'].strip() and type(x.get('exit_code')) is int and x['exit_code'] == 0 for x in checks), 'Actual passing checks required')
        hashes[role] = digest
    require(type(data.get('pr_number')) is int and data['pr_number'] > 0, 'PR number required')
    return data, {'manifest': manifest_hash, 'reports': hashes}


def current_issue(call, key, config):
    issue = call(['issue', 'get', key, '--output', 'json'])
    require(issue.get('identifier') == key and issue.get('project_id') == config['project'], 'Wrong manual issue/project')
    require(issue.get('metadata', {}).get('automation_mode') == 'manual', 'Explicit manual issue required')
    return issue


def observe(github, number, head, merged=False):
    github.cache.clear()
    pr = github.api(f'pulls/{number}')
    require(pr.get('number') == number and pr['head']['sha'] == head and pr['base']['ref'] == 'main' and pr['base']['repo']['full_name'] == github.repo and (pr['head'].get('repo') or {}).get('full_name') == github.repo, 'PR repository/base/head mismatch')
    require((bool(pr.get('merged_at')) and pr.get('state') == 'closed') if merged else (pr.get('state') == 'open' and not pr.get('draft') and not pr.get('merged_at')), 'PR must be merged' if merged else 'Ready open PR required')
    head_ci = github.ci(head, 'pull_request')
    require(head_ci.get('state') == 'success' and head_ci.get('sha') == head and head_ci.get('run_id'), 'Exact-head PR CI required')
    base = github.api('commits/main')['sha']
    require(isinstance(base, str) and SHA.fullmatch(base), 'Invalid live main')
    base_ci = github.ci(base, 'push')
    require(base_ci.get('state') == 'success' and base_ci.get('sha') == base and base_ci.get('run_id'), 'Exact main push CI required')
    return {'pr': pr, 'base': base, 'head_ci': head_ci, 'base_ci': base_ci}


def stable(github, observed, number):
    pr = github.api(f'pulls/{number}')
    before = observed['pr']
    require(all(pr.get(k) == before.get(k) for k in ('state', 'draft', 'merged_at', 'merge_commit_sha')) and pr['head']['sha'] == before['head']['sha'] and pr['base']['ref'] == 'main' and github.api('commits/main')['sha'] == observed['base'], 'PR/main moved during observation')


def receipt_path(state, key, head):
    return safe_path(state / 'manual-merges' / f'{key}-{head}.json')


def atomic_receipt(path, payload):
    path = safe_path(path)
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    raw = (json.dumps(payload, sort_keys=True, indent=2) + '\n').encode()
    fd, name = tempfile.mkstemp(prefix='.pending-', dir=path.parent)
    try:
        with os.fdopen(fd, 'wb') as out:
            out.write(raw); out.flush(); os.fsync(out.fileno())
        os.link(name, path)  # Never overwrite a receipt, even after interruption.
    finally:
        os.unlink(name)


def execute(mode, root, state, config, github, call, key, head, manifest_path):
    require(not os.environ.get('MULTICA_TASK_ID'), 'Manual merge receipts require explicit human operator')
    require(KEY.fullmatch(key) and SHA.fullmatch(head), 'Full approved head and issue required')
    require(mode in ('approve-manual-merge', 'verify-manual-merge'), 'Unknown manual operation')
    started = time.monotonic()
    ledger_clear(state, key)
    issue = current_issue(call, key, config)
    data, hashes = evidence(manifest_path, key, head, github.repo, issue)
    number = data['pr_number']
    require(str(issue.get('metadata', {}).get('pr_number')) == str(number), 'Issue PR binding missing or changed')
    path = receipt_path(state, key, head)
    old = read_json(path)[0] if path.exists() else None
    observed = observe(github, number, head, mode == 'verify-manual-merge')
    identity = {'schema_version': 1, 'kind': 'manual_merge_intent', 'issue': key, 'repository': github.repo, 'head': head, 'pr_number': number, 'method': 'squash', 'evidence': hashes, 'approval_reference': data['approval_reference']}
    if mode == 'approve-manual-merge':
        # Local objects must already be fetched by the operator; no ref/worktree mutation.
        tree = _text(root, 'merge-tree', '--write-tree', observed['base'], head).splitlines()[0]
        require(SHA.fullmatch(tree), 'Expected integration tree unavailable')
        if 'capacity' in config:
            require(_text(root, 'merge-base', observed['base'], head) == observed['base'], 'Current main compatibility must be reverified')
            require(data.get('compatibility_base') == observed['base'], 'Fresh manual compatibility base required')
            for entry in data['reports'].values():
                report = read_json(Path(manifest_path).parent / entry['path'])[0]
                require(report.get('compatibility_base') == observed['base'], 'Every role must verify current main compatibility')
        binding = {**identity, 'base': observed['base'], 'expected_tree': tree, 'head_ci': observed['head_ci'], 'base_ci': observed['base_ci']}
        if old:
            require({k: v for k, v in old.items() if k != 'recorded_at'} == binding, 'Manual intent changed; explicit reconciliation required')
        result = old or {**binding, 'recorded_at': datetime.now(timezone.utc).isoformat()}
    else:
        require(old is not None and all(old.get(k) == v for k, v in identity.items()), 'Matching immutable manual intent required')
        merged = observed['pr'].get('merge_commit_sha')
        require(merged == observed['base'], 'Main moved after manual merge')
        proof = verify_squash_merge(root, head, merged, old['base'])
        require(_text(root, 'rev-parse', merged + '^{tree}') == old['expected_tree'], 'Captured integration tree mismatch')
        result = {'kind': 'manual_merge_verified', 'intent': str(path), 'merge': merged, 'integration_ci': observed['base_ci'], 'proof': proof, 'issue': key, 'head': head}
    latest_issue = current_issue(call, key, config)
    require(str(latest_issue.get('metadata', {}).get('pr_number')) == str(number), 'Issue PR binding changed during observation')
    require(evidence(manifest_path, key, head, github.repo, latest_issue)[1] == hashes, 'Evidence changed during observation')
    ledger_clear(state, key)
    stable(github, observed, number)
    latest = observe(github, number, head, mode == 'verify-manual-merge')
    require(all(latest[k] == observed[k] for k in ('base', 'head_ci', 'base_ci')) and latest['pr'].get('merge_commit_sha') == observed['pr'].get('merge_commit_sha'), 'CI or integration binding changed during observation')
    require(time.monotonic() - started < 120, 'Manual observation expired')
    if 'capacity' in config:
        from capacity import Capacity
        capacity = Capacity(state, config['capacity']['port_base'])
        try:
            if mode == 'approve-manual-merge':
                capacity.claim_integration(key, head, result['base'], result['expected_tree'])
            else:
                capacity.complete_integration(key, head, old['base'], old['expected_tree'], result['merge'])
        finally:
            capacity.close()
    if mode == 'approve-manual-merge' and old is None:
        atomic_receipt(path, result)
    return result
