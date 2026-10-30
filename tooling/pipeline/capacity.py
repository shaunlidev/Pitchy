"""Durable capacity and integration reservations for the canonical dispatcher.

No timeout releases ownership. This coordinates controlled operations; it is
not an OS sandbox, a database provisioner, or authority to enable parallelism.
"""
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import uuid

from controller import Hold

RUNNING = {'queued', 'dispatched', 'running', 'waiting_local_directory', 'deferred'}
TERMINAL = {'completed', 'failed', 'cancelled'}


def require(value, message):
    if not value:
        raise Hold(message)


def hex40(value):
    return isinstance(value, str) and re.fullmatch(r'[a-f0-9]{40}', value)


def clean_path(value):
    require(isinstance(value, str) and value and not value.startswith('/') and '\\' not in value
            and all(p not in ('', '.', '..') for p in value.split('/')) and not any(c in value for c in '*?[]'), 'Exact relative source paths required')
    return value


def scope(issue):
    raw = issue.get('metadata', {}).get('capacity_scope')
    try:
        value = json.loads(raw) if isinstance(raw, str) else raw
        require(isinstance(value, dict) and set(value) == {'paths', 'shared'}, 'Explicit capacity scope required')
        paths = value['paths']
        require(isinstance(paths, list) and paths and len(paths) == len(set(paths)) and type(value['shared']) is bool, 'Invalid capacity scope')
        paths = sorted(clean_path(p) for p in paths)
        sensitive = any(re.search(r'(^|/)(\.github|tooling|core|api|contracts?|migrations?|schema)(/|\.)|config|package\.json|lock', p, re.I) for p in paths)
        return {'paths': paths, 'shared': value['shared'] or sensitive}
    except (ValueError, TypeError) as error:
        raise Hold('Invalid capacity scope') from error


def overlap(a, b):
    return a['shared'] or b['shared'] or any(x == y or x.startswith(y + '/') or y.startswith(x + '/') for x in a['paths'] for y in b['paths'])


def inventory(call, daemon, maximum_age=120):
    """Read every visible workspace issue/run, including other projects."""
    started = time.monotonic()
    runtimes = call(['runtime', 'list', '--output', 'json'])
    require(isinstance(runtimes, list) and all(isinstance(r, dict) for r in runtimes), 'Machine runtime inventory unavailable')
    require(all(isinstance(r.get('id'), str) and r['id'] for r in runtimes), 'Unknown runtime identity')
    require(len({r.get('id') for r in runtimes}) == len(runtimes), 'Duplicate runtime identities')
    selected = [r for r in runtimes if r.get('daemon_id') == daemon]
    require(selected, 'Machine daemon not observed')
    now = datetime.now(timezone.utc)
    for row in selected:
        try:
            stamp = datetime.fromisoformat(row['last_seen_at'].replace('Z', '+00:00'))
            age = (now - stamp).total_seconds()
            require(row['status'] == 'online' and 0 <= age <= maximum_age, 'Machine runtime offline or stale')
        except (KeyError, ValueError, TypeError) as error:
            raise Hold('Unknown runtime heartbeat') from error
    machine_ids = {r['id'] for r in selected}
    known_ids = {r['id'] for r in runtimes}
    issues, seen, offset = [], set(), 0
    while True:
        data = call(['issue', 'list', '--limit', '100', '--offset', str(offset), '--output', 'json'])
        require(isinstance(data, (list, dict)), 'Workspace inventory malformed')
        require(not isinstance(data, dict) or type(data.get('has_more')) is bool, 'Workspace pagination state unknown')
        rows = data if isinstance(data, list) else data.get('issues')
        require(isinstance(rows, list), 'Workspace issue inventory unavailable')
        for row in rows:
            require(isinstance(row, dict) and isinstance(row.get('id'), str) and row['id'] not in seen, 'Duplicate or unknown workspace issue')
            seen.add(row['id']); issues.append(row)
        more = isinstance(data, dict) and data.get('has_more')
        if not more and len(rows) < 100:
            break
        require(rows and offset < 100000, 'Incomplete workspace issue inventory')
        offset += len(rows)
    runs, run_ids = [], set()
    for issue in issues:
        history = call(['issue', 'runs', issue['id'], '--output', 'json'])
        require(isinstance(history, list), 'Unknown runtime history')
        for run in history:
            require(isinstance(run, dict) and isinstance(run.get('id'), str) and run['id'] not in run_ids
                    and run.get('issue_id') == issue['id'] and isinstance(run.get('status'), str) and run.get('status') in RUNNING | TERMINAL, 'Malformed runtime identity/history')
            run_ids.add(run['id'])
            if run['status'] in RUNNING:
                require(isinstance(run.get('runtime_id'), str) and run['runtime_id'] in known_ids, 'Active runtime has unknown machine')
                if run['runtime_id'] in machine_ids:
                    require(isinstance(run.get('agent_id'), str) and run['agent_id'], 'Active runtime actor unavailable')
                    runs.append(run)
    require(time.monotonic() - started < maximum_age, 'Machine inventory expired')
    return {'runs': runs, 'deadline': started + maximum_age, 'daemon': daemon}


def authorized_lanes(root, state, requested, fingerprint):
    require(type(requested) is int and requested in (1, 2), 'At most two task lanes')
    if requested == 1:
        return 1
    try:
        path = Path(state) / 'parallel-authorization.json'
        require(not any(p.is_symlink() for p in (path, *path.parents)), 'Parallel authorization symlink refused')
        grant = json.loads(path.read_text())
        require(grant.get('lanes') == 2 and type(grant.get('lanes')) is int
                and grant.get('source_fingerprint') == fingerprint
                and isinstance(grant.get('approval_reference'), str) and grant['approval_reference'].strip()
                and grant.get('authority') == 'direct_human_parallel_activation', 'Fresh human parallel authorization required')
    except (OSError, ValueError, TypeError, AttributeError) as error:
        raise Hold('Fresh human parallel authorization required') from error
    return 2


def validate_lease(value):
    require(isinstance(value, dict) and isinstance(value.get('issue'), str) and re.fullmatch(r'PIT-[1-9][0-9]*', value['issue'])
            and isinstance(value.get('id'), str) and value['id'] and isinstance(value.get('lease_id'), str)
            and re.fullmatch(r'[a-f0-9]{32}', value['lease_id']) and type(value.get('slot')) is int and value['slot'] in (1,2)
            and type(value.get('port')) is int and 1024 <= value['port'] <= 65535 and hex40(value.get('base'))
            and isinstance(value.get('runs'), dict) and (value.get('reservation') is None or isinstance(value['reservation'], str)),
            'Malformed capacity lease; reconciliation required')
    require(scope({'metadata': {'capacity_scope': value.get('scope')}}) == value['scope'], 'Malformed capacity scope')
    return value


class Capacity:
    def __init__(self, state, port_base=43100):
        self.state = Path(state).absolute()
        require(not any(p.is_symlink() for p in (self.state, *self.state.parents)), 'Capacity state symlink refused')
        require(not (self.state / 'capacity.sqlite3').is_symlink(), 'Capacity database symlink refused')
        self.state.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.state / 'capacity.sqlite3', timeout=30)
        self.db.executescript('''CREATE TABLE IF NOT EXISTS leases (issue TEXT PRIMARY KEY, slot INTEGER, retired INTEGER NOT NULL, data TEXT NOT NULL);
            CREATE UNIQUE INDEX IF NOT EXISTS live_slot ON leases(slot) WHERE retired=0;
            CREATE TABLE IF NOT EXISTS bindings (kind TEXT, value TEXT, owner TEXT, run TEXT, PRIMARY KEY(kind,value));
            CREATE TABLE IF NOT EXISTS integration (singleton INTEGER PRIMARY KEY CHECK(singleton=1), data TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS integration_history (head TEXT PRIMARY KEY, data TEXT NOT NULL);''')
        self.db.commit()
        self.port_base = port_base

    def close(self):
        self.db.close()

    @contextmanager
    def transaction(self):
        self.db.execute('BEGIN IMMEDIATE')
        try:
            yield
            self.db.commit()
        except BaseException:
            self.db.rollback()
            raise

    def leases(self):
        return {k: validate_lease(json.loads(v)) for k, v in self.db.execute('SELECT issue,data FROM leases WHERE retired=0')}

    def get(self, key):
        row = self.db.execute('SELECT data FROM leases WHERE issue=? AND retired=0', (key,)).fetchone()
        require(row is not None, 'Capacity lease missing; explicit reconciliation required')
        return validate_lease(json.loads(row[0]))

    def save(self, lease):
        self.db.execute('UPDATE leases SET data=? WHERE issue=?', (json.dumps(lease), lease['issue']))

    def room(self, observed, extra=1, own=None):
        require(isinstance(observed, dict) and time.monotonic() < observed.get('deadline', 0), 'Fresh machine inventory required')
        runs = observed['runs']
        require(len({r['id'] for r in runs}) == len(runs), 'Duplicate active run')
        active_issues = {r['issue_id'] for r in runs}
        pending = sum(1 for lease in self.leases().values() if lease.get('reservation') and lease['id'] not in active_issues and lease['issue'] != own)
        require(len(runs) + pending + extra <= 5, 'Machine cap five including pending starts')

    def candidate(self, issue, base, observed, limit):
        require(type(limit) is int and limit in (1, 2) and hex40(base), 'Invalid capacity/base')
        require(isinstance(issue.get('capacity_actor'), str) and issue['capacity_actor'], 'Admitted developer identity required')
        require(issue['identifier'] not in self.leases(), 'Lease already exists; no duplicate admission')
        leases = self.leases()
        require(len(leases) < limit, 'Task lane capacity occupied')
        selected = scope(issue)
        require(not any(overlap(selected, lease['scope']) for lease in leases.values()), 'Shared source surface requires serial execution')
        self.room(observed)
        return selected

    def admit(self, issue, base, observed, limit):
        with self.transaction():
            selected = self.candidate(issue, base, observed, limit)
            require(not self.db.execute('SELECT 1 FROM leases WHERE issue=?', (issue['identifier'],)).fetchone(), 'Retired issue cannot be silently reused')
            slots = {x['slot'] for x in self.leases().values()}
            slot = next(n for n in range(1, limit + 1) if n not in slots)
            lease = {'issue': issue['identifier'], 'id': issue['id'], 'lease_id': uuid.uuid4().hex, 'slot': slot,
                     'base': base, 'scope': selected, 'reservation': 'admission', 'runs': {}, 'expected_actor': issue.get('capacity_actor'), 'port': self.port_base + slot * 10}
            self.db.execute('INSERT INTO leases VALUES (?,?,0,?)', (lease['issue'], slot, json.dumps(lease)))
            return lease

    def reserve_run(self, key, token, actor, observed):
        with self.transaction():
            lease = self.get(key)
            existing = lease.get('reservation')
            require(existing in (None, token), 'Prior run reservation unresolved')
            require(not any(r['issue_id'] == lease['id'] for r in observed['runs']), 'Prior task runtime is not terminal')
            self.room(observed, own=key)
            lease['reservation'] = token
            lease['expected_actor'] = actor
            self.save(lease)

    def bind(self, key, actor, run, workdir, branch):
        path = Path(workdir).absolute()
        require(path.is_dir() and not any(p.is_symlink() for p in (path, *path.parents)), 'Unsafe resource workspace')
        require(isinstance(run, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,128}', run), 'Invalid resource run')
        require(isinstance(branch, str) and branch and branch not in ('main', 'HEAD'), 'Isolated bound branch required')
        with self.transaction():
            lease = self.get(key)
            prior = lease['runs'].get(run)
            binding = {'actor': actor, 'workspace': str(path), 'branch': branch}
            if prior:
                require(prior == binding, 'Runtime resource identity changed')
            else:
                require(lease.get('reservation') and lease.get('expected_actor') == actor, 'Unreserved or foreign runtime')
                for kind, value in (('workspace', str(path)), ('branch', branch)):
                    row = self.db.execute('SELECT owner,run FROM bindings WHERE kind=? AND value=?', (kind, value)).fetchone()
                    require(row is None or row == (key, run), 'Resource already owned by a different task/run')
                    self.db.execute('INSERT OR IGNORE INTO bindings VALUES (?,?,?,?)', (kind, value, key, run))
                lease['runs'][run] = binding
                lease['reservation'] = None
                lease.pop('expected_actor', None)
                self.save(lease)
            suffix = hashlib.sha256((lease['lease_id'] + run).encode()).hexdigest()[:24]
            resources = self.state / 'resources' / lease['lease_id'] / run
            return {'lease_id': lease['lease_id'], 'port': lease['port'], 'database': 'pitchroom_test_' + suffix,
                    'browser_state': str(resources / 'browser'), 'build_output': str(path / 'pitchroom-app/apps/web/.next'),
                    'workspace': str(path), 'branch': branch}

    def environment(self, key, actor, run, workdir, branch, checkout):
        value = self.bind(key, actor, run, workdir, branch)
        path = Path(checkout).absolute()
        require(path.is_dir() and path.is_relative_to(Path(workdir).absolute()) and
                not any(p.is_symlink() for p in (path, *path.parents)), 'Unsafe check resource workspace')
        with self.transaction():
            row = self.db.execute('SELECT owner,run FROM bindings WHERE kind=? AND value=?', ('checkout', str(path))).fetchone()
            require(row is None or row == (key, run), 'Check directory belongs to another runtime')
            self.db.execute('INSERT OR IGNORE INTO bindings VALUES (?,?,?,?)', ('checkout', str(path), key, run))
        value['build_output'] = str(path / 'pitchroom-app/apps/web/.next')
        return {'PORT': str(value['port']), 'PGDATABASE': value['database'],
                'DATABASE_URL': 'postgresql://pitchroom_test@127.0.0.1:5432/' + value['database'],
                'PITCHROOM_TEST_DATABASE_URL': 'postgresql://pitchroom_test@127.0.0.1:5432/' + value['database'],
                'PITCHROOM_BROWSER_STATE_DIR': value['browser_state'], 'PITCHROOM_BUILD_OUTPUT': value['build_output'],
                'PITCHROOM_CAPACITY_LEASE': value['lease_id']}

    def claim_integration(self, issue, head, base, expected_tree):
        require(all(hex40(x) for x in (head, base, expected_tree)), 'Exact integration identity required')
        value = {'issue': issue, 'head': head, 'base': base, 'tree': expected_tree}
        with self.transaction():
            row = self.db.execute('SELECT data FROM integration WHERE singleton=1').fetchone()
            require(row is None or json.loads(row[0]) == value, 'Another or changed integration owns the single merge slot')
            self.db.execute('INSERT OR IGNORE INTO integration VALUES (1,?)', (json.dumps(value),))
        return value

    def complete_integration(self, issue, head, base, tree, merge):
        require(hex40(merge), 'Verified merge identity required')
        expected = {'issue': issue, 'head': head, 'base': base, 'tree': tree}
        with self.transaction():
            completed = {**expected, 'merge': merge}
            prior = self.db.execute('SELECT data FROM integration_history WHERE head=?', (head,)).fetchone()
            if prior:
                require(json.loads(prior[0]) == completed, 'Completed integration identity changed')
                return
            row = self.db.execute('SELECT data FROM integration WHERE singleton=1').fetchone()
            require(row is not None and json.loads(row[0]) == expected, 'Integration reservation differs')
            self.db.execute('INSERT INTO integration_history VALUES (?,?)', (head, json.dumps(completed)))
            # Release only after caller verifies real squash/tree/main CI.
            self.db.execute('DELETE FROM integration WHERE singleton=1')

    def retire(self, key, lease_id, observed, persistence):
        with self.transaction():
            lease = self.get(key)
            require(lease['lease_id'] == lease_id and not lease.get('reservation'), 'Unresolved lease identity/start')
            self.room(observed, extra=0)
            require(not any(r['issue_id'] == lease['id'] for r in observed['runs']), 'Active runtime prevents retirement')
            require(not self.db.execute('SELECT 1 FROM integration').fetchone(), 'Integration still reserved')
            require(isinstance(persistence, dict) and hex40(persistence.get('merge')) and isinstance(persistence.get('evidence'), list) and persistence['evidence'], 'Verified durable source/evidence required')
            lease['retirement'] = persistence
            self.db.execute('UPDATE leases SET retired=1,data=? WHERE issue=?', (json.dumps(lease), key))
        return {'issue': key, 'retired': True, 'deleted_files': []}


def read_status(state):
    path = Path(state) / 'capacity.sqlite3'
    if not path.exists():
        return {'state': 'uninitialized', 'leases': [], 'integration': None}
    require(not any(p.is_symlink() for p in (path, *path.parents)) and not any(path.with_name(path.name + suffix).exists() for suffix in ('-wal', '-journal')), 'Capacity database unavailable')
    before = path.stat(); raw = path.read_bytes(); after = path.stat()
    require((before.st_size, before.st_mtime_ns) == (after.st_size, after.st_mtime_ns), 'Capacity changed during read')
    db = sqlite3.connect(':memory:')
    try:
        db.deserialize(raw); db.execute('PRAGMA query_only=ON')
        leases = [validate_lease(json.loads(x[0])) for x in db.execute('SELECT data FROM leases WHERE retired=0')]
        row = db.execute('SELECT data FROM integration WHERE singleton=1').fetchone()
        integration = json.loads(row[0]) if row else None
        require(integration is None or (isinstance(integration, dict) and set(integration) == {'issue','head','base','tree'}
                and isinstance(integration['issue'], str) and re.fullmatch(r'PIT-[1-9][0-9]*', integration['issue'])
                and all(hex40(integration[k]) for k in ('head','base','tree'))), 'Malformed integration reservation')
        return {'state': 'known', 'leases': leases, 'integration': integration}
    finally:
        db.close()
