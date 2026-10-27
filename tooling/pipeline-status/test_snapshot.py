#!/usr/bin/env python3
"""Synthetic subprocess acceptance checks; emits a single JSON proof object."""
from datetime import datetime, timezone
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location('snapshot', HERE / 'snapshot.py')
s = importlib.util.module_from_spec(spec)
spec.loader.exec_module(s)
NOW = datetime(2026, 10, 27, tzinfo=timezone.utc)
HEAD = 'a' * 40
SYNTHETIC_MARKER = 'synthetic-redaction-marker'


def fixture():
    return {'identifier': 'PIT-61', 'status': 'in_progress',
            'assignee_id': 'da50eeba-d5bf-4215-b872-340cec62ade7',
            'description': SYNTHETIC_MARKER, 'instructions': SYNTHETIC_MARKER, 'logs': SYNTHETIC_MARKER,
            'metadata': {'token': SYNTHETIC_MARKER, 'github_sync_state': 'fresh',
                         'github_sync_observed_at': NOW.isoformat(),
                         'github_prs': json.dumps([{'number': 11, 'head': HEAD,
                             'base': 'main', 'state': 'DRAFT', 'logs': SYNTHETIC_MARKER,
                             'ci': {'state': 'success', 'sha': HEAD}}])}}


def pr_fixture():
    return {'number': 11, 'headRefName': 'codex/pit-61-delivery-g1',
            'headRefOid': HEAD, 'baseRefName': 'main', 'state': 'OPEN', 'body': SYNTHETIC_MARKER}


class SnapshotTests(unittest.TestCase):
    def observe(self, issue=None, pr=None):
        return s.snapshot(live=True, reader=lambda _: fixture() if issue is None else issue,
                          pr_reader=lambda _: pr_fixture() if pr is None else pr, now=NOW)

    def test_offline_never_calls_cli(self):
        def forbidden(*args):
            self.fail('Offline CLI access')
        result = s.snapshot(reader=forbidden, pr_reader=forbidden)
        self.assertFalse(result['live_checked'])
        self.assertFalse(result['passed'])
        self.assertEqual(result['blocked_reasons'], ['not_connected'])

    def test_current_observable_fields_and_allowlist(self):
        result = self.observe()
        self.assertTrue(result['passed'])
        self.assertEqual(set(result), set(s.FIELDS))
        for name, value in {'stage': 'in_progress', 'owner': fixture()['assignee_id'],
                            'branch': 'codex/pit-61-delivery-g1', 'pr': 11,
                            'head': HEAD, 'ci': 'success',
                            'next_action': 'await_serial_scheduler',
                            'human_decision_required': False}.items():
            self.assertEqual(result[name], value)
        self.assertNotIn(SYNTHETIC_MARKER, json.dumps(result))

    def test_expiry_future_and_missing_observation(self):
        for stamp in ['2026-10-26T00:00:00+00:00', '2026-10-28T00:00:00+00:00',
                      'invalid', '2026-10-27T00:00:00', None]:
            with self.subTest(stamp=stamp):
                row = fixture(); row['metadata']['github_sync_observed_at'] = stamp
                self.assertFalse(self.observe(row)['passed'])

    def test_ci_failure_missing_mismatch_and_sync_failure(self):
        for state in ['failure', 'pending', 'missing', 'skipped', 'cancelled', SYNTHETIC_MARKER, None]:
            row = fixture(); prs = json.loads(row['metadata']['github_prs'])
            prs[0]['ci']['state'] = state
            row['metadata']['github_prs'] = json.dumps(prs)
            result = self.observe(row)
            self.assertFalse(result['passed']); self.assertNotIn(SYNTHETIC_MARKER, json.dumps(result))
        for mutate in [lambda p: p[0]['ci'].update(sha='b'*40), lambda p: p.clear(),
                       lambda p: p.append(p[0]), lambda p: p[0].update(base='other'),
                       lambda p: p[0].update(state='CLOSED')]:
            row = fixture(); prs = json.loads(row['metadata']['github_prs']); mutate(prs)
            row['metadata']['github_prs'] = json.dumps(prs)
            self.assertFalse(self.observe(row)['passed'])
        row = fixture(); row['metadata']['github_sync_state'] = 'unavailable'
        self.assertFalse(self.observe(row)['passed'])

    def test_changed_pr_and_human_hold(self):
        for field, value in [('headRefOid', 'b'*40), ('baseRefName', 'other'),
                             ('state', 'CLOSED'), ('headRefName', SYNTHETIC_MARKER)]:
            pr = pr_fixture(); pr[field] = value
            result = self.observe(pr=pr)
            self.assertFalse(result['passed']); self.assertNotIn(SYNTHETIC_MARKER, json.dumps(result))
        for stage in ['in_review', 'blocked']:
            row = fixture(); row['status'] = stage
            result = self.observe(row)
            self.assertTrue(result['human_decision_required'])
            self.assertEqual(result['next_action'], 'await_human_decision' if stage == 'in_review' else 'resolve_observation_or_task_hold')
        for row in [{}, [], {'identifier': 'PIT-62'}, {**fixture(), 'status': []}]:
            self.assertFalse(self.observe(row)['passed'])

    def test_real_entrypoint_synthetic_cli_and_no_writes(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            row = fixture()
            row['metadata']['github_sync_observed_at'] = datetime.now(timezone.utc).isoformat()
            (root/'issue.json').write_text(json.dumps(row))
            (root/'pr.json').write_text(json.dumps(pr_fixture()))
            script = '#!' + sys.executable + '''
import json, pathlib, sys
root=pathlib.Path(__file__).parent
args=sys.argv[1:]
with (root/'calls').open('a') as f: f.write(json.dumps(args)+'\\n')
if args == ['issue','get','PIT-61','--output','json']:
    print((root/'issue.json').read_text())
elif args == ['pr','view','11','--repo','shaunlidev/pitchroom','--json','number,headRefName,headRefOid,baseRefName,state']:
    print((root/'pr.json').read_text())
else:
    print('synthetic-redaction-marker',file=sys.stderr)
    sys.exit(9)
'''
            for name in ['multica', 'gh']:
                path = root/name; path.write_text(script); path.chmod(0o700)
            env = {'PATH': str(root), 'SYNTHETIC_SECRET': SYNTHETIC_MARKER}
            def run(*args):
                return subprocess.run([sys.executable, '-B', str(HERE/'snapshot.py'), *args],
                                      cwd=root, env=env, capture_output=True, text=True, timeout=10)
            offline = run(); self.assertEqual(offline.returncode, 0)
            self.assertFalse((root/'calls').exists())
            live = run('--live'); self.assertEqual(live.returncode, 0, live.stderr)
            self.assertTrue(json.loads(live.stdout)['passed'])
            self.assertEqual(len((root/'calls').read_text().splitlines()), 2)
            self.assertNotIn(SYNTHETIC_MARKER, live.stdout + live.stderr)
            (root/'issue.json').write_text('bad json')
            failure = run('--live'); self.assertEqual(failure.returncode, 2)
            self.assertFalse(json.loads(failure.stdout)['passed'])
            (root/'multica').write_text('#!' + sys.executable + '\nimport sys\nprint("synthetic-redaction-marker",file=sys.stderr)\nsys.exit(1)\n')
            failure = run('--live'); self.assertEqual(failure.returncode, 2)
            self.assertNotIn(SYNTHETIC_MARKER, failure.stdout + failure.stderr)
            invalid = run('--issue', '--bad'); self.assertNotEqual(invalid.returncode, 0)

    def test_observation_expires_during_reads(self):
        with patch.object(s.time, 'monotonic', side_effect=[0, 121]):
            result = self.observe()
        self.assertFalse(result['passed'])
        self.assertIn('observation_expired', result['blocked_reasons'])

    def test_timeout_is_sanitized(self):
        with patch.object(s.subprocess, 'run', side_effect=subprocess.TimeoutExpired(SYNTHETIC_MARKER, 30)):
            result = s.snapshot(live=True)
        self.assertFalse(result['passed'])
        self.assertNotIn(SYNTHETIC_MARKER, json.dumps(result))


if __name__ == '__main__':
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream).run(unittest.defaultTestLoader.loadTestsFromTestCase(SnapshotTests))
    print(json.dumps({'passed': result.wasSuccessful(), 'tests_run': result.testsRun,
                      'failures': len(result.failures), 'errors': len(result.errors)}))
    if not result.wasSuccessful():
        print(stream.getvalue(), file=sys.stderr)
    raise SystemExit(0 if result.wasSuccessful() else 1)
