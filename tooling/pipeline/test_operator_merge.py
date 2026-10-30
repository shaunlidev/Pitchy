import copy
import contextlib
import io
import hashlib
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import operator_merge as m
from artifacts import ArtifactError
from controller import Hold


class Remote:
    repo = 'owner/project'

    def __init__(self, head, base):
        self.cache = {}
        self.base = base
        self.states = {}
        self.pr = {'number': 21, 'head': {'sha': head, 'repo': {'full_name': self.repo}}, 'base': {'ref': 'main', 'repo': {'full_name': self.repo}}, 'state': 'open', 'draft': False, 'merged_at': None, 'merge_commit_sha': None}

    def api(self, path):
        return copy.deepcopy(self.pr) if path == 'pulls/21' else {'sha': self.base}

    def ci(self, sha, event):
        return {'state': self.states.get((sha, event), 'success'), 'sha': sha, 'run_id': 1 if event == 'pull_request' else 2}


class ManualMergeTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        self.env = {**os.environ, 'GIT_CONFIG_GLOBAL': os.devnull, 'GIT_CONFIG_NOSYSTEM': '1', 'GIT_TERMINAL_PROMPT': '0'}
        self.git('init', '-q', '--template=')
        self.git('config', 'user.name', 'Synthetic')
        self.git('config', 'user.email', 'synthetic@example.invalid')
        (self.root / 'base').write_text('base')
        self.git('add', 'base'); self.git('commit', '-qm', 'base')
        self.base = self.git('rev-parse', 'HEAD')
        (self.root / 'feature').write_text('feature')
        self.git('add', 'feature'); self.git('commit', '-qm', 'feature')
        self.head = self.git('rev-parse', 'HEAD')
        self.state = self.root / '.state'; self.state.mkdir()
        with sqlite3.connect(self.state / 'ledger.sqlite3') as db:
            db.execute('CREATE TABLE lanes(issue TEXT PRIMARY KEY,data TEXT)')
            db.execute('CREATE TABLE operations(token TEXT PRIMARY KEY,state TEXT)')
        self.ledger = (self.state / 'ledger.sqlite3').read_bytes()
        (self.state / 'activation.json').write_text('original activation')
        self.remote = Remote(self.head, self.base)
        self.issue = {'identifier': 'PIT-53', 'project_id': 'p', 'description': 'Complete original acceptance', 'metadata': {'automation_mode': 'manual', 'pr_number': 21}}
        self.manifest = self.root / 'evidence' / 'manifest.json'; self.manifest.parent.mkdir()
        contract = hashlib.sha256(self.issue['description'].encode()).hexdigest()
        self.data = {'schema_version': 1, 'kind': 'manual_delivery', 'repository': self.remote.repo, 'issue': 'PIT-53', 'head': self.head, 'pr_number': 21, 'description_sha256': contract, 'complete_contract': True, 'approval_reference': 'direct-human-test', 'criteria': ['owner-live', 'no-duplicate'], 'reports': {}}
        for role in ('developer', 'reviewer', 'qa'):
            report = {'issue': 'PIT-53', 'head': self.head, 'description_sha256': contract, 'role': role, 'actor': role, 'complete_contract_review': True, 'verdict': 'pass', 'criterion_results': {k: 'pass' for k in self.data['criteria']}, 'failures': [], 'not_run': [], 'decisions': [], 'checks': [{'command': 'synthetic behavioral test', 'exit_code': 0}]}
            self.write_report(role, report)
        self.save()
        self.calls = []

    def git(self, *args):
        return subprocess.check_output(['git', '-c', 'core.hooksPath=/dev/null', '-C', str(self.root), *args], env=self.env, stderr=subprocess.DEVNULL, text=True).strip()

    def write_report(self, role, value):
        path = self.manifest.parent / (role + '.json')
        path.write_text(json.dumps(value))
        self.data['reports'][role] = {'path': path.name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()}

    def save(self):
        self.manifest.write_text(json.dumps(self.data))

    def call(self, args):
        self.calls.append(args)
        self.assertEqual(args, ['issue', 'get', 'PIT-53', '--output', 'json'])
        return copy.deepcopy(self.issue)

    def run_mode(self, mode='approve-manual-merge'):
        return m.execute(mode, self.root, self.state, {'project': 'p'}, self.remote, self.call, 'PIT-53', self.head, self.manifest)

    def receipt(self):
        return m.receipt_path(self.state, 'PIT-53', self.head)

    def assert_no_receipt(self):
        self.assertFalse(self.receipt().exists())
        self.assertEqual((self.state / 'ledger.sqlite3').read_bytes(), self.ledger)
        self.assertEqual((self.state / 'activation.json').read_text(), 'original activation')

    def test_cli_routes_without_initializing_or_activating_controller(self):
        import serial
        control = self.root / 'tooling/pipeline'; control.mkdir(parents=True)
        (control / 'policy.json').write_text(json.dumps({'repository': self.remote.repo}))
        args = ['serial.py', 'approve-manual-merge', 'PIT-53', '--approved-head', self.head, '--manifest', str(self.manifest)]
        with patch.object(serial, 'SOURCE', self.root), patch.object(serial, 'canonical', return_value=self.root), patch.object(serial, 'load_config', return_value=({'repository': self.remote.repo}, {})), patch.object(serial, 'Serial', side_effect=AssertionError('controller must not initialize')), patch.object(m, 'execute', return_value={'ok': True}) as execute, patch('sys.argv', args), contextlib.redirect_stdout(io.StringIO()):
            serial.main()
            self.assertEqual(execute.call_args.args[0], 'approve-manual-merge')
        self.assertEqual((self.state / 'activation.json').read_text(), 'original activation')

    def test_task_copy_cli_is_rejected(self):
        import serial
        with patch.object(serial, 'canonical', return_value=self.root), patch('sys.argv', ['serial.py', 'approve-manual-merge', 'PIT-53', '--approved-head', self.head, '--manifest', str(self.manifest)]), self.assertRaisesRegex(Hold, 'canonical'):
            serial.main()

    def test_wrong_tree_and_moved_main_after_merge_rejected(self):
        self.run_mode()
        wrong = self.git('commit-tree', self.git('rev-parse', self.base + '^{tree}'), '-p', self.base, '-m', 'missing feature')
        self.remote.base = wrong; self.remote.pr.update(state='closed', merged_at='now', merge_commit_sha=wrong)
        with self.assertRaises(ArtifactError): self.run_mode('verify-manual-merge')
        self.remote.base = self.head
        with self.assertRaisesRegex(Hold, 'Main moved'): self.run_mode('verify-manual-merge')

    def test_module_changes_invalidate_activation_without_reactivation(self):
        from serial import Serial, fingerprint, FINGERPRINT_FILES
        control = self.root / 'tooling/pipeline'; control.mkdir(parents=True)
        for name in FINGERPRINT_FILES:
            (control / name).write_text('synthetic identity')
        activation = self.state / 'activation.json'
        activation.write_text(json.dumps({'verified': True, 'task_lanes': 1, 'source_fingerprint': fingerprint(self.root), 'integrated_commit': self.head}))
        before = activation.read_bytes()
        controller = Serial.__new__(Serial); controller.root = self.state; controller.c = {'repository': self.root}; controller.policy = {'dispatch_control_default': 'admission_paused'}
        controller.require_enabled()
        (control / 'operator_merge.py').write_text('changed identity')
        with self.assertRaisesRegex(Hold, 'stale'): controller.require_enabled()
        self.assertEqual(activation.read_bytes(), before)

    def test_real_git_intent_idempotent_no_lane_schedule_or_checkout_mutation(self):
        before = self.git('status', '--porcelain')
        intent = self.run_mode(); raw = self.receipt().read_bytes()
        self.assertEqual(intent['expected_tree'], self.git('rev-parse', self.head + '^{tree}'))
        self.assertEqual(self.run_mode(), intent); self.assertEqual(self.receipt().read_bytes(), raw)
        self.assertEqual(before, self.git('status', '--porcelain'))
        self.assertEqual((self.state / 'ledger.sqlite3').read_bytes(), self.ledger)
        self.assertEqual((self.state / 'activation.json').read_text(), 'original activation')
        self.assertEqual(self.receipt().stat().st_mode & 0o777, 0o600)

    def test_real_squash_verify_and_no_automatic_done(self):
        intent = self.run_mode()
        merge = self.git('commit-tree', intent['expected_tree'], '-p', self.base, '-m', 'squash')
        self.remote.base = merge
        self.remote.pr.update(state='closed', merged_at='now', merge_commit_sha=merge)
        result = self.run_mode('verify-manual-merge')
        self.assertEqual(result['proof']['parent'], self.base)
        self.assertEqual(result['merge'], merge)
        self.assertEqual((self.state / 'ledger.sqlite3').read_bytes(), self.ledger)

    def test_operator_only(self):
        with patch.dict(os.environ, {'MULTICA_TASK_ID': 'native'}), self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_no_lane_or_uncertain_operations(self):
        for table, values in [('lanes', ('PIT-53', '{}')), ('operations', ('uncertain-test', 'uncertain'))]:
            with self.subTest(table=table):
                with sqlite3.connect(self.state / 'ledger.sqlite3') as db: db.execute(f'INSERT INTO {table} VALUES (?,?)', values)
                with self.assertRaises(Hold): self.run_mode()
                with sqlite3.connect(self.state / 'ledger.sqlite3') as db: db.execute(f'DELETE FROM {table}')
        self.assertFalse(self.receipt().exists())

    def test_wrong_manifest_identity_or_approval(self):
        for key, value in [('head', 'a'*40), ('issue', 'PIT-54'), ('repository', 'other/repo'), ('description_sha256', 'a'*64), ('approval_reference', ''), ('complete_contract', False), ('criteria', [])]:
            old = self.data[key]; self.data[key] = value; self.save()
            with self.subTest(key=key), self.assertRaises(Hold): self.run_mode()
            self.data[key] = old
        self.assert_no_receipt()

    def test_role_evidence_missing_tampered_stale_incomplete_or_nonindependent(self):
        path = self.manifest.parent / 'qa.json'; original = json.loads(path.read_text())
        for key, value in [('head', 'a'*40), ('actor', 'reviewer'), ('complete_contract_review', False), ('criterion_results', {'owner-live': 'pass'}), ('not_run', ['no-duplicate']), ('checks', []), ('verdict', 'fail')]:
            report = {**original, key: value}; self.write_report('qa', report); self.save()
            with self.subTest(key=key), self.assertRaises(Hold): self.run_mode()
        self.write_report('qa', original); self.save(); path.write_text('{}')
        with self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_report_containment_symlinks_and_limits(self):
        self.data['reports']['qa']['path'] = '../qa.json'; self.save()
        with self.assertRaises(Hold): self.run_mode()
        self.data['reports']['qa']['path'] = 'alias/qa.json'; self.save()
        (self.manifest.parent / 'alias').symlink_to(self.manifest.parent, target_is_directory=True)
        with self.assertRaises(Hold): self.run_mode()
        with patch.object(m, 'LIMIT', 10), self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_wrong_issue_project_manual_or_pr_binding(self):
        variants = [{'identifier': 'PIT-54'}, {'project_id': 'other'}, {'metadata': {'automation_mode': 'automatic', 'pr_number': 21}}, {'metadata': {'automation_mode': 'manual', 'pr_number': 22}}]
        original = copy.deepcopy(self.issue)
        for variant in variants:
            self.issue = {**original, **variant}
            with self.subTest(variant=variant), self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_draft_closed_changed_head_or_base_rejected(self):
        original = copy.deepcopy(self.remote.pr)
        for update in [{'draft': True}, {'state': 'closed'}, {'head': {'sha': 'a'*40}}, {'base': {'ref': 'other'}}]:
            self.remote.pr = {**original, **update}
            with self.subTest(update=update), self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_missing_or_failed_ci_rejected(self):
        for sha, event in [(self.head, 'pull_request'), (self.base, 'push')]:
            for state in ('failure', 'pending', 'missing'):
                self.remote.states[(sha, event)] = state
                with self.subTest(event=event, state=state), self.assertRaises(Hold): self.run_mode()
            self.remote.states.clear()
        self.assert_no_receipt()

    def test_changed_base_cannot_overwrite_intent(self):
        self.run_mode(); raw = self.receipt().read_bytes(); self.remote.base = self.head
        with self.assertRaises(Hold): self.run_mode()
        self.assertEqual(self.receipt().read_bytes(), raw)

    def test_observation_expiry_and_movement(self):
        with patch.object(m.time, 'monotonic', side_effect=[0, 121]), self.assertRaises(Hold): self.run_mode()
        original = self.remote.api; counts = 0
        def changed(path):
            nonlocal counts
            if path == 'commits/main':
                counts += 1
                if counts > 1: return {'sha': self.head}
            return original(path)
        self.remote.api = changed
        with self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_ci_and_issue_binding_change_during_observation(self):
        original = self.remote.ci; calls = 0
        def changing(sha, event):
            nonlocal calls
            calls += 1
            result = original(sha, event)
            if calls > 2: result['run_id'] += 1
            return result
        self.remote.ci = changing
        with self.assertRaises(Hold): self.run_mode()
        self.remote.ci = original
        original_call = self.call; reads = 0
        def changed_issue(args):
            nonlocal reads
            reads += 1
            result = original_call(args)
            if reads > 1: result['metadata']['pr_number'] = 22
            return result
        self.call = changed_issue
        with self.assertRaises(Hold): self.run_mode()
        self.assert_no_receipt()

    def test_conflict_refused(self):
        with patch.object(m, '_text', side_effect=ArtifactError('merge conflict')), self.assertRaises(ArtifactError): self.run_mode()
        self.assert_no_receipt()

    def test_receipt_symlink_and_no_overwrite(self):
        self.receipt().parent.mkdir(); self.receipt().symlink_to(self.manifest)
        with self.assertRaises(Hold): self.run_mode()
        target = self.root / 'immutable.json'; m.atomic_receipt(target, {'a': 1})
        with self.assertRaises(FileExistsError): m.atomic_receipt(target, {'a': 2})
        self.assertEqual(json.loads(target.read_text()), {'a': 1})

    def test_verify_requires_matching_intent_and_merge_ci(self):
        self.remote.pr.update(state='closed', merged_at='now', merge_commit_sha=self.base)
        with self.assertRaises(Hold): self.run_mode('verify-manual-merge')
        self.remote.pr.update(state='open', merged_at=None, merge_commit_sha=None)
        intent = self.run_mode()
        wrong = self.git('commit-tree', intent['expected_tree'], '-p', self.head, '-m', 'wrong parent')
        self.remote.base = wrong; self.remote.pr.update(state='closed', merged_at='now', merge_commit_sha=wrong)
        with self.assertRaises(ArtifactError): self.run_mode('verify-manual-merge')
        self.remote.states[(wrong, 'push')] = 'failure'
        with self.assertRaises(Hold): self.run_mode('verify-manual-merge')


if __name__ == '__main__': unittest.main()
