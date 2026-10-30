#!/usr/bin/env python3
"""Offline behavioral checks; stdout is a machine-verifiable JSON receipt."""
from datetime import datetime, timedelta, timezone
import io
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import snapshot
import view

NOW = datetime(2026, 10, 27, tzinfo=timezone.utc)
HEAD = 'a' * 40
MARKER = 'SECRET-RAW-CONTENT'


def fixture():
    return dict(zip(snapshot.FIELDS, (1, True, NOW.isoformat(), 'PIT-62',
        'in_review', 'da50eeba-d5bf-4215-b872-340cec62ade7',
        'codex/pit-62-delivery-g1', 12, HEAD, 'success', [],
        'await_human_decision', True, True)))


class ViewTests(unittest.TestCase):
    def test_merge_candidate_is_not_merge_authorization(self):
        text, usable = view.render(fixture(), NOW)
        self.assertTrue(usable)
        for expected in ('等人工验收', HEAD, 'PR #12', 'CI 通过',
                         '等待人工对精确head', '可合并：无法判断',
                         'runtime completed：无法判断', '工程完成：无法判断',
                         '产品接受：无法判断', '部署：无法判断'):
            self.assertIn(expected, text)

    def test_every_ci_state(self):
        for state, label in view.CI.items():
            with self.subTest(state=state):
                data = fixture()
                data.update(ci=state, passed=state == 'success',
                            blocked_reasons=[] if state == 'success' else ['ci_not_successful'],
                            next_action='await_human_decision' if state == 'success'
                            else 'resolve_observation_or_task_hold')
                text, usable = view.render(data, NOW)
                self.assertTrue(usable)
                self.assertIn('CI ' + label, text)
                if state != 'success':
                    self.assertNotIn('CI 通过', text)

    def test_cli_rejects_contradictory_ci_evidence(self):
        command = [sys.executable, '-B', str(Path(view.__file__))]
        cases = [('success', ['ci_not_successful'], False),
                 ('success', ['ci_not_successful'], True),
                 ('failure', [], False), ('missing', [], False)]
        for ci, reasons, passed in cases:
            with self.subTest(ci=ci, reasons=reasons, passed=passed):
                data = fixture()
                data.update(observed_at=datetime.now(timezone.utc).isoformat(),
                            ci=ci, blocked_reasons=reasons, passed=passed)
                result = subprocess.run(command, input=json.dumps(data),
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('检查：无法判断', result.stdout)
                self.assertNotIn('检查：CI 通过', result.stdout)
                self.assertIn('获取新快照', result.stdout)

    def test_cli_rejects_invalid_or_contradictory_action(self):
        command = [sys.executable, '-B', str(Path(view.__file__))]
        for action in (None, 42, 'unknown', [], {}, 'await_serial_scheduler',
                       'resolve_observation_or_task_hold', 'request_live_snapshot'):
            with self.subTest(action=action):
                data = fixture()
                data.update(observed_at=datetime.now(timezone.utc).isoformat(),
                            next_action=action)
                result = subprocess.run(command, input=json.dumps(data),
                                        text=True, capture_output=True)
                self.assertEqual(result.returncode, 2, result.stdout)
                self.assertIn('检查：无法判断', result.stdout)
                self.assertNotIn('检查：CI 通过', result.stdout)
                self.assertIn('获取新快照', result.stdout)

    def test_producer_stage_ci_action_matrix(self):
        for stage in snapshot.STAGES:
            for ci in snapshot.CI_STATES:
                with self.subTest(stage=stage, ci=ci):
                    issue = {'identifier': 'PIT-62', 'status': stage,
                             'assignee_id': fixture()['owner'], 'metadata': {
                                 'github_sync_observed_at': NOW.isoformat(),
                                 'github_sync_state': 'fresh',
                                 'github_prs': [{'number': 12, 'head': HEAD,
                                     'base': 'main', 'state': 'DRAFT',
                                     'ci': {'sha': HEAD, 'state': ci}}]}}
                    pr = {'number': 12, 'headRefName': fixture()['branch'],
                          'headRefOid': HEAD, 'baseRefName': 'main', 'state': 'OPEN'}
                    data = snapshot.snapshot('PIT-62', True, reader=lambda _: issue,
                                             now=NOW, pr_reader=lambda _: pr)
                    text, usable = view.render(data, NOW)
                    self.assertTrue(usable)
                    self.assertIn(view.ACTIONS[data['next_action']], text)
                    self.assertIn('CI ' + view.CI[ci], text)
                    self.assertIn('工程完成：无法判断', text)
                    for wrong in (None, not data['human_decision_required']):
                        altered = dict(data, human_decision_required=wrong)
                        rejected, accepted = view.render(altered, NOW)
                        self.assertFalse(accepted)
                        self.assertNotIn('检查：CI 通过', rejected)

    def test_stale_future_and_offline(self):
        for delta in (-121, 1):
            data = fixture()
            data['observed_at'] = (NOW + timedelta(seconds=delta)).isoformat()
            text, usable = view.render(data, NOW)
            self.assertFalse(usable)
            self.assertIn('无法判断', text)
            self.assertNotIn('CI 通过', text)
        data = snapshot.snapshot()
        self.assertFalse(view.render(data, NOW)[1])

    def test_incomplete_corrupt_and_wrong_types(self):
        for field in snapshot.FIELDS:
            data = fixture()
            del data[field]
            self.assertFalse(view.render(data, NOW)[1], field)
        for data in (None, [], 'raw', {}, {'schema_version': 2}):
            self.assertFalse(view.render(data, NOW)[1])
        for field in ('stage', 'ci', 'blocked_reasons', 'observed_at', 'head',
                      'branch', 'pr', 'passed', 'live_checked', 'owner'):
            data = fixture()
            data[field] = {'raw': MARKER}
            text, usable = view.render(data, NOW)
            self.assertFalse(usable, field)
            self.assertNotIn(MARKER, text)

    def test_no_raw_content_or_extra_gate_claims(self):
        data = fixture()
        data.update(logs=MARKER, runtime='completed', ready_to_merge=True,
                    engineering_done=True, deployed=True)
        data['blocked_reasons'] = [MARKER]
        data['next_action'] = MARKER
        data['passed'] = False
        before = json.dumps(data, sort_keys=True)
        with patch('subprocess.run', side_effect=AssertionError('external call')):
            text, usable = view.render(data, NOW)
        self.assertFalse(usable)
        self.assertNotIn(MARKER, text)
        self.assertIn('可合并：无法判断', text)
        self.assertEqual(before, json.dumps(data, sort_keys=True))

    def test_all_stages_and_scheduler_action(self):
        for stage, label in view.STAGES.items():
            data = fixture()
            human = stage in {'in_review', 'blocked'}
            action = ('resolve_observation_or_task_hold' if stage == 'blocked' else
                      'await_human_decision' if human else 'await_serial_scheduler')
            data.update(stage=stage, human_decision_required=human, next_action=action,
                        blocked_reasons=['task_blocked'] if stage == 'blocked' else [],
                        passed=stage != 'blocked')
            text, usable = view.render(data, NOW)
            self.assertTrue(usable)
            self.assertIn(label, text)
            self.assertIn(view.ACTIONS[action], text)
            self.assertIn('工程完成：无法判断', text)

    def test_cli_stdin_file_and_errors_are_read_only(self):
        command = [sys.executable, '-B', str(Path(view.__file__))]
        data = fixture()
        data['observed_at'] = datetime.now(timezone.utc).isoformat()
        content = json.dumps(data)
        result = subprocess.run(command, input=content, text=True, capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn(HEAD, result.stdout)
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'snapshot.json'
            path.write_text(content)
            result = subprocess.run(command + [str(path)], text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(path.read_text(), content)
            self.assertEqual([p.name for p in Path(directory).iterdir()], ['snapshot.json'])
            path.write_text('{"secret": "' + MARKER)
            for args, stdin in (([str(path)], None), ([str(path) + '-missing'], None), ([], '')):
                result = subprocess.run(command + args, input=stdin, text=True, capture_output=True)
                self.assertEqual(result.returncode, 2)
                self.assertIn('无法判断', result.stdout)
                self.assertNotIn(MARKER, result.stdout + result.stderr)


if __name__ == '__main__':
    suite = unittest.defaultTestLoader.loadTestsFromTestCase(ViewTests)
    stream = io.StringIO()
    result = unittest.TextTestRunner(stream=stream, verbosity=2).run(suite)
    print(json.dumps({'passed': result.wasSuccessful(), 'tests_run': result.testsRun,
                      'failures': len(result.failures), 'errors': len(result.errors),
                      'details': stream.getvalue()}, ensure_ascii=False))
    raise SystemExit(0 if result.wasSuccessful() else 1)
