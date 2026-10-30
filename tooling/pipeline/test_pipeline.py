import copy
from datetime import datetime, timezone
import hashlib
import sqlite3
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(Path(__file__).resolve().parent))
sys.path.insert(0, str(ROOT / 'tooling/pitchroom-github-sync'))
import ci
import status
import delivery


class PipelineBehavior(unittest.TestCase):
    def diagnostic_workspace(self, root, name='a'):
        workspace = root / 'pitchroom-app/packages' / name
        workspace.mkdir(parents=True)
        (workspace / 'package.json').write_text(json.dumps({'scripts': {'test': 'vitest run'}}))
        source = workspace / 'src/example.test.ts'
        source.parent.mkdir()
        source.write_text('it("keeps the declared boundary", () => {});\n')
        return workspace, source

    def diagnostic_report(self, source, title='keeps the declared boundary'):
        return {
            'numTotalTests': 1, 'numPassedTests': 0, 'numFailedTests': 1,
            'numPendingTests': 0, 'numTodoTests': 0,
            'testResults': [{'name': str(source), 'status': 'failed', 'assertionResults': [{
                'title': title, 'status': 'failed',
                'failureMessages': ['AssertionError: synthetic-private-message'],
                'meta': {'untrusted': 'synthetic-private-meta'},
            }]}],
        }

    def test_unit_reports_are_fresh_and_separate_per_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            a, _ = self.diagnostic_workspace(root, 'a')
            b, _ = self.diagnostic_workspace(root, 'b')
            with patch.object(ci, 'APP', root / 'pitchroom-app'):
                command, reports = ci.unit_reports(root / 'attempt-one')
                self.assertEqual(command[:6], ['pnpm', '-r', '--if-present', 'run', 'test', '--reporter=json'])
                self.assertEqual({x[0] for x in reports}, {a, b})
                self.assertNotEqual(reports[0][1], reports[1][1])
                old = reports[0][1]
                old.parent.mkdir(parents=True)
                old.write_text('old-private-report')
                with self.assertRaisesRegex(ValueError, 'report_already_exists'):
                    ci.unit_reports(root / 'attempt-one')
                _, fresh = ci.unit_reports(root / 'attempt-two')
                self.assertTrue(all(not p.exists() for _, p in fresh))
                self.assertEqual(old.read_text(), 'old-private-report')

    def test_unit_failure_summary_keeps_case_identity_without_raw_values(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace, source = self.diagnostic_workspace(root)
            report = workspace / 'unit.json'
            report.write_text(json.dumps(self.diagnostic_report(source)))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'APP', root / 'pitchroom-app'):
                summary = ci.summarize_unit([(workspace, report)], {source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}, 7, {'node': 'v24.10.0'})
                self.assertEqual(summary['exit'], 7)
                self.assertEqual(summary['failures'][0]['test'], 'keeps the declared boundary')
                self.assertEqual(summary['failures'][0]['declaration_line'], 1)
                self.assertEqual(summary['failures'][0]['category'], 'assertion')
                self.assertEqual(len(summary['failures'][0]['failure_hash']), 64)
                encoded = json.dumps(summary)
                self.assertNotIn('synthetic-private-message', encoded)
                self.assertNotIn('synthetic-private-meta', encoded)

    def test_failure_location_is_limited_to_the_known_source_file(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _, source = self.diagnostic_workspace(root)
            tracked = {source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}
            with patch.object(ci, 'ROOT', root):
                record = ci.failure_record(str(source), {'title': 'keeps the declared boundary', 'failureMessages': [f'AssertionError: synthetic-private\n at {source}:1:4']}, tracked)
                self.assertEqual(record['failure_location'], {'line': 1, 'column': 4})
                self.assertNotIn('synthetic-private', json.dumps(record))
                bad = ci.failure_record(str(source), {'title': '', 'failureMessages': [f'at {source}:999999:4']}, tracked)
                self.assertIsNone(bad['failure_location'])

    def test_report_cannot_publish_invented_or_sensitive_case_names(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _, source = self.diagnostic_workspace(root)
            tracked = {source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}
            sensitive = 'sk-' + 'a' * 24
            source.write_text(source.read_text() + 'it("' + sensitive + '",()=>{});\n')
            with patch.object(ci, 'ROOT', root):
                for title in ('invented-private-input', sensitive, '::error\nprivate-input'):
                    record = ci.failure_record(str(source), {'title': title, 'failureMessages': []}, tracked)
                    self.assertIsNone(record['test'])
                    self.assertNotIn(title, json.dumps(record))

    def test_static_catalogue_rejects_comments_strings_and_ambiguous_syntax(self):
        sources = [
            '// it("private-comment",()=>{});',
            'const example = \'it("private-string",()=>{});\';',
            '/*\nit("private-block",()=>{});\n*/',
            'const example = `\nit("private-template",()=>{});\n`;',
            'const example = `outer ${`it("private-nested",()=>{})`}`;',
            'const example = "continued\\\nit(\'private-continued\',()=>{})";',
        ]
        for source in sources:
            self.assertEqual(ci.static_test_metadata(source, '.ts')['titles'], {})
        self.assertEqual(ci.static_test_metadata('it("jsx-text",()=>{});', '.tsx')['titles'], {})

    def test_static_catalogue_filters_every_source_guard_credential_family(self):
        samples = ['sk-' + 'a' * 24, 'github_pat_' + 'a' * 24, 'AKIA' + 'A' * 16]
        samples += ['gh' + family + '_' + 'a' * 24 for family in 'pousr']
        samples += ['authorization=' + 'private-value', 'access_token=' + 'private-value']
        for sample in samples:
            self.assertEqual(ci.static_test_metadata('it("' + sample + '",()=>{});', '.ts')['titles'], {})

    def test_catalogue_is_pinned_to_head_and_never_rereads_mutable_source(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _, source = self.diagnostic_workspace(root)
            git_env = ci.environment('unit', os.environ)
            git_env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1', GIT_TERMINAL_PROMPT='0')
            git = ['git', '-c', 'core.hooksPath=/dev/null', '-c', 'init.templateDir=']
            subprocess.run([*git, 'init', '-q'], cwd=root, env=git_env, check=True, capture_output=True)
            subprocess.run([*git, 'add', '.'], cwd=root, env=git_env, check=True, capture_output=True)
            subprocess.run([*git, '-c', 'user.name=SyntheticHarness', '-c', 'user.email=harness@example.invalid', 'commit', '-qm', 'synthetic baseline'], cwd=root, env=git_env, check=True, capture_output=True)
            head = subprocess.check_output([*git, 'rev-parse', 'HEAD'], cwd=root, env=git_env, text=True).strip()
            with patch.object(ci, 'ROOT', root):
                catalogue = ci.tracked_tests(git_env, head)
                source.write_text(source.read_text() + '// it("SYNTHETIC_PRIVATE_DYNAMIC_TITLE",()=>{});\n')
                with patch.object(Path, 'read_text') as read:
                    record = ci.failure_record(str(source), {'title': 'SYNTHETIC_PRIVATE_DYNAMIC_TITLE', 'failureMessages': []}, catalogue)
                    read.assert_not_called()
                self.assertIsNone(record['test'])
                self.assertIsNone(record['declaration_line'])
                self.assertNotIn('SYNTHETIC_PRIVATE_DYNAMIC_TITLE', json.dumps(record))
                safe = ci.failure_record(str(source), {'title': 'keeps the declared boundary', 'failureMessages': []}, catalogue)
                self.assertEqual(safe['test'], 'keeps the declared boundary')

    def test_duplicate_titles_have_distinct_hashed_suite_identity(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            _, source = self.diagnostic_workspace(root)
            source.write_text(source.read_text() * 2)
            with patch.object(ci, 'ROOT', root):
                records = [ci.failure_record(str(source), {'title': 'keeps the declared boundary', 'fullName': name, 'failureMessages': []}, {source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}) for name in ('suite A keeps the declared boundary', 'suite B keeps the declared boundary')]
            self.assertNotEqual(records[0]['case_id'], records[1]['case_id'])
            self.assertIsNone(records[0]['declaration_line'])

    def test_report_rejects_symlink_and_does_not_read_target(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace, _ = self.diagnostic_workspace(root)
            target = root / 'private.json'
            target.write_text('synthetic-private-value')
            report = workspace / 'unit.json'
            report.symlink_to(target)
            with patch.object(ci, 'APP', root / 'pitchroom-app'), patch.object(Path, 'read_text') as read:
                summary = ci.summarize_unit([(workspace, report)], set(), 1, {})
                read.assert_not_called()
            self.assertEqual(summary['workspaces'][0]['status'], 'diagnostics_unavailable')
            self.assertNotIn('synthetic-private-value', json.dumps(summary))

    def test_missing_malformed_oversized_and_untracked_reports_are_not_success(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace, source = self.diagnostic_workspace(root)
            report = workspace / 'unit.json'
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'APP', root / 'pitchroom-app'):
                cases = (None, 'not-json', 'x' * (ci.REPORT_LIMIT + 1), json.dumps(self.diagnostic_report(source)))
                for contents in cases:
                    if contents is not None:
                        report.write_text(contents)
                    summary = ci.summarize_unit([(workspace, report)], set(), 9, {})
                    self.assertEqual(summary['exit'], 9)
                    self.assertEqual(summary['status'], 'unattributed_nonzero_exit')
                    self.assertEqual(summary['workspaces'][0]['status'], 'diagnostics_unavailable')

    def test_file_collection_error_is_identified_without_raw_message(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace, source = self.diagnostic_workspace(root)
            packet = self.diagnostic_report(source)
            packet['testResults'][0].update(assertionResults=[], message='synthetic-private-import-failure')
            report = workspace / 'unit.json'
            report.write_text(json.dumps(packet))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'APP', root / 'pitchroom-app'):
                summary = ci.summarize_unit([(workspace, report)], {source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}, 1, {})
            self.assertIsNone(summary['failures'][0]['test'])
            self.assertEqual(summary['failures'][0]['file'], source.relative_to(root).as_posix())
            self.assertNotIn('synthetic-private-import-failure', json.dumps(summary))

    def test_summary_size_and_failure_count_are_bounded(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace, source = self.diagnostic_workspace(root)
            packet = self.diagnostic_report(source)
            packet['testResults'][0]['assertionResults'] *= 40
            report = workspace / 'unit.json'
            report.write_text(json.dumps(packet))
            with patch.object(ci, 'ROOT', root), patch.object(ci, 'APP', root / 'pitchroom-app'):
                summary = ci.summarize_unit([(workspace, report)], {source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}, 1, {})
            self.assertEqual(len(summary['failures']), ci.FAILURE_LIMIT)
            self.assertEqual(summary['omitted_failures'], 40 - ci.FAILURE_LIMIT)
            with patch('builtins.print') as output:
                ci.print_unit_summary(summary)
            self.assertLessEqual(len(output.call_args.args[0].encode()), ci.SUMMARY_LIMIT + len('unit-diagnostics: '))

    def test_run_unit_preserves_failure_exit_and_keeps_raw_output_local(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory).resolve()
            workspace, source = self.diagnostic_workspace(root)

            def child(argv, **options):
                relative = argv[-1].removeprefix('--outputFile=')
                report = workspace / relative
                report.parent.mkdir(parents=True)
                report.write_text(json.dumps(self.diagnostic_report(source)))
                options['stdout'].write(b'synthetic-private-stdout')
                return subprocess.CompletedProcess(argv, 7)

            with patch.object(ci, 'ROOT', root), patch.object(ci, 'APP', root / 'pitchroom-app'), patch.dict(os.environ, {'RUNNER_TEMP': directory}), patch.object(ci, 'tracked_tests', return_value={source.relative_to(root).as_posix(): ci.static_test_metadata(source.read_text(), source.suffix)}), patch.object(ci, 'diagnostic_context', return_value={'head': 'a' * 40}), patch.object(ci.subprocess, 'run', side_effect=child), patch('builtins.print') as output:
                self.assertEqual(ci.run_stage('unit'), 7)
                printed = '\n'.join(call.args[0] for call in output.call_args_list)
                self.assertIn('keeps the declared boundary', printed)
                self.assertNotIn('synthetic-private-stdout', printed)
                self.assertNotIn('synthetic-private-message', printed)
            self.assertIn('synthetic-private-stdout', next(root.glob('pitchroom-ci-*/*.log')).read_text())

    def test_diagnostic_context_accepts_only_version_platform_and_sha_shapes(self):
        values = ('v24.10.0', '9.6.0', 'a' * 40, 'linux', 'x64')
        with patch.object(ci.subprocess, 'run', side_effect=[subprocess.CompletedProcess([], 0, value) for value in values]):
            self.assertEqual(ci.diagnostic_context({})['head'], 'a' * 40)
        with patch.object(ci.subprocess, 'run', return_value=subprocess.CompletedProcess([], 0, 'synthetic-private-value')):
            self.assertTrue(all(value is None for value in ci.diagnostic_context({}).values()))

    def test_ci_environment_cannot_inherit_provider_or_personal_database(self):
        source = {'PATH': '/bin', 'OPENAI_API_KEY': 'test-provider', 'GITHUB_TOKEN': 'test-token', 'DATABASE_URL': 'test-personal', 'PITCHROOM_RUNTIME': 'live'}
        normal = ci.environment('unit', source)
        self.assertNotIn('OPENAI_API_KEY', normal)
        self.assertNotIn('GITHUB_TOKEN', normal)
        self.assertNotIn('DATABASE_URL', normal)
        self.assertEqual(normal['PITCHROOM_RUNTIME'], 'fixture')
        self.assertIn('127.0.0.1:55437/clarify_qa', ci.environment('database', source)['DATABASE_URL'])

    def test_failed_command_is_nonzero_and_does_not_print_raw_output(self):
        with tempfile.TemporaryDirectory() as directory:
            with patch.dict(ci.STAGES, {'synthetic': [sys.executable, '-c', 'print("synthetic-private-output"); raise SystemExit(7)']}), patch.dict(os.environ, {'RUNNER_TEMP': directory}), patch('builtins.print') as output:
                self.assertEqual(ci.run_stage('synthetic'), 7)
                self.assertNotIn('synthetic-private-output', str(output.call_args_list))
            self.assertIn('synthetic-private-output', next(Path(directory).rglob('*.log')).read_text())

    def test_only_explicit_infrastructure_paths_are_publishable(self):
        self.assertTrue(delivery.allowed_path('.github/workflows/pr-ci.yml'))
        self.assertTrue(delivery.allowed_path('tooling/pipeline/policy.json'))
        for path in ('.github/workflows/unknown.yml', '.github/secrets.json', 'docs/development/private.md', 'tooling/pipeline/.state.json', 'tooling/pipeline/results.log'):
            self.assertFalse(delivery.allowed_path(path), path)

    def test_workflow_has_no_raw_uploads_or_privileged_pr_trigger(self):
        workflow = (ROOT / '.github/workflows/pr-ci.yml').read_text()
        for forbidden in ('pull_request_target', 'upload-artifact', 'secrets.', 'continue-on-error', 'npm install', 'playwright install'):
            self.assertNotIn(forbidden, workflow)
        self.assertIn('fetch-depth: 0', workflow)
        self.assertIn('persist-credentials: false', workflow)
        self.assertIn('if: always()', workflow)
        self.assertIn('needs: [source, application]', workflow)
        self.assertEqual(workflow.count('python3 tooling/pipeline/ci.py '), len(ci.STAGES))


class OperationalStatus(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        folder = self.root / 'tooling/pipeline'
        folder.mkdir(parents=True)
        for name in status.FINGERPRINT_FILES:
            (folder / name).write_bytes((ROOT / 'tooling/pipeline' / name).read_bytes())
        self.policy, self.config = status.load_config(self.root)
        self.state = self.root / 'state'
        self.state.mkdir()
        self.now = datetime.now(timezone.utc)
        self.head, self.tree, self.merge = 'a' * 40, 'b' * 40, 'c' * 40
        description=hashlib.sha256(b'Original acceptance').hexdigest()
        self.lane = {'issue':'PIT-1', 'id':'00000000-0000-0000-0000-000000000003',
                     'description_sha256':description, 'phase':'awaiting_merge', 'generation':1,
                     'branch':'codex/pit-1-test', 'pr_number':1,
                     'artifact': {'issue':'PIT-1','commit':self.head, 'tree':self.tree, 'contract_sha256':hashlib.sha256(b'Frozen contract').hexdigest(), 'description_sha256':description},
                     'receipts':{}}
        self.runs = []
        for n, role in enumerate(('reviewer','qa'), 1):
            run = f'00000000-0000-0000-0000-{n:012d}'
            self.lane['receipts'][role] = {'issue':'PIT-1','role':role, 'actor_id':self.config[role], 'run_id':run,
                'generation':1, 'commit':self.head, 'tree':self.tree, 'contract_sha256':hashlib.sha256(b'Frozen contract').hexdigest(),
                'description_sha256':description, 'outcome':'pass', 'dirty':False, 'complete_contract_review':True}
            self.runs.append({'id':run,'issue_id':self.lane['id'],'agent_id':self.config[role],'status':'completed'})
        self.issue = {'id':'00000000-0000-0000-0000-000000000003', 'identifier':'PIT-1',
                      'project_id':self.config['project'], 'description':'Original acceptance', 'status':'in_review', 'assignee_id':self.config['owner']}
        self.pr = {'number':1, 'head':self.head, 'state':'DRAFT', 'base':'main',
                   'ci':{'state':'success','sha':self.head,'run_id':1}}
        self.write('activation.json', {'source_fingerprint':status.fingerprint(self.root), 'task_lanes':1,
                   'verified':True, 'integrated_commit':self.merge})
        self.write('sync-health.json', {'state':'fresh','observed_at':self.now.isoformat()})
        db = sqlite3.connect(self.state/'ledger.sqlite3')
        db.execute('CREATE TABLE lanes (issue TEXT PRIMARY KEY, data TEXT NOT NULL)')
        db.execute('CREATE TABLE operations (token TEXT PRIMARY KEY, state TEXT NOT NULL)')
        db.execute('INSERT INTO lanes VALUES (?,?)', ('PIT-1', json.dumps(self.lane)))
        db.commit(); db.close()

    def write(self, name, value):
        (self.state/name).write_text(json.dumps(value))

    def view(self, **changes):
        args = dict(key='PIT-1',lane=self.lane,issue=self.issue,runs=self.runs,pr=self.pr,config=self.config,fresh=True)
        return status.task_view(**{**args, **changes})

    def inventory(self):
        return {str(p.relative_to(self.root)):hashlib.sha256(p.read_bytes()).hexdigest() for p in self.root.rglob('*') if p.is_file()}

    def test_one_owner_for_policy_and_runtime_shadows_fail(self):
        self.assertEqual(self.config['max_lanes'], self.policy['task_lanes'])
        p = self.root/'tooling/pipeline/runtime.json'
        original = json.loads(p.read_text())
        for key, value in [('max_lanes',1),('project','other'),('repository','other/repo'),
                           ('machine_cap',6),('default_base','dev'),('automatic_done',False),('enabled',True)]:
            with self.subTest(key=key):
                p.write_text(json.dumps({**original,key:value}))
                with self.assertRaises(ValueError): status.load_config(self.root)
        p.write_text(json.dumps(original))

    def test_optional_roles_are_dormant_and_configuration_is_validated(self):
        options = self.config['optional_roles']
        self.assertIs(options['small_tasks_enabled'], False)
        self.assertIs(options['supplemental_enabled'], False)
        self.assertEqual(self.config['max_lanes'], 1)
        path = self.root/'tooling/pipeline/runtime.json'
        original = json.loads(path.read_text())
        for changes in ({'small_tasks_enabled': 1}, {'unknown': False},
                        {'supplemental_agent': self.config['reviewer']},
                        {'small_tasks_agent': 'invalid'}):
            with self.subTest(changes=changes):
                path.write_text(json.dumps({**original, 'optional_roles': {**options, **changes}}))
                with self.assertRaises(ValueError): status.load_config(self.root)
        path.write_text(json.dumps(original))
        self.assertTrue(self.view()['ready_to_merge'])

    def test_optional_routing_displays_actual_role_and_drift_holds(self):
        options = self.config['optional_roles']
        options.update(small_tasks_enabled=True, supplemental_enabled=True)
        self.issue['metadata'] = {'developer_route': 'small', 'supplemental_review': 'on'}
        self.lane['routing'] = {**self.issue['metadata'], 'actors': {
            'developer': options['small_tasks_agent'], 'reviewer': self.config['reviewer'],
            'qa': self.config['qa'], 'supplemental': options['supplemental_agent']}}
        self.assertTrue(self.view()['ready_to_merge'])
        self.lane['phase'] = 'supplemental'
        self.issue['status'] = 'started_2'
        self.runs.append({'id': '00000000-0000-0000-0000-000000000099',
                          'issue_id': self.issue['id'], 'agent_id': options['supplemental_agent'], 'status': 'running'})
        row = self.view()
        self.assertEqual(row['controller_phase'], 'supplemental')
        self.assertEqual(row['active_runs'][0]['role'], 'supplemental')
        self.assertFalse(row['ready_to_merge'])
        self.runs.pop(); self.lane['phase'] = 'awaiting_merge'; self.issue['status'] = 'in_review'
        options['supplemental_enabled'] = False
        row = self.view()
        self.assertFalse(row['ready_to_merge'])
        self.assertIn('routing_changed_or_disabled', row['blocked_reasons'])
        options['supplemental_enabled'] = True
        self.issue['metadata']['developer_route'] = 'default'
        self.assertFalse(self.view()['ready_to_merge'])
        self.assertIn('routing_changed_or_disabled', self.view()['blocked_reasons'])
        self.lane.pop('routing')
        self.assertFalse(self.view()['ready_to_merge'])

    def test_unsupported_lane_and_completion_policy_fail_closed(self):
        p = self.root/'tooling/pipeline/policy.json'
        original = json.loads(p.read_text())
        for key,value in [('task_lanes',2),('task_lanes',True),('engineering_done_requires',['ci']),
                          ('dispatch_control_default','open'),('automatic_deployment',True)]:
            p.write_text(json.dumps({**original,key:value}))
            result = status.snapshot(root=self.root,state=self.state)
            self.assertEqual(result['errors'], ['configuration_invalid'])
        p.write_text(json.dumps(original))

    def test_fingerprint_includes_status_validation_and_policy(self):
        self.assertEqual(status.activation_state(self.root,self.state)['state'], 'valid')
        for name in ('status.py','policy.json','operator_merge.py'):
            path = self.root/'tooling/pipeline'/name
            original = path.read_bytes(); path.write_bytes(original+b' ')
            self.assertEqual(status.activation_state(self.root,self.state)['state'], 'stale')
            path.write_bytes(original)
        (self.state/'activation.json').write_text('[]')
        self.assertEqual(status.activation_state(self.root,self.state)['state'], 'invalid')

    def test_default_pause_and_stale_operator_control_cannot_enable(self):
        self.assertEqual(status.control_state(self.root,self.state,self.policy)['mode'], 'admission_paused')
        self.write('control.json', {'mode':'open','source_fingerprint':'old'})
        result = status.control_state(self.root,self.state,self.policy)
        self.assertEqual(result['mode'],'maintenance'); self.assertFalse(result['valid'])
        self.write('control.json', {'mode':'open','source_fingerprint':status.fingerprint(self.root)})
        self.assertEqual(status.control_state(self.root,self.state,self.policy)['mode'],'open')

    def test_malformed_shared_contract_digest_revokes_role_acceptance(self):
        self.assertTrue(self.view()['ready_to_merge'])
        for value in (None, '', 'contract', 'g'*64, 'a'*63, 'a'*65, True, 17,
                      {'broken': 'digest'}, ['a'*64]):
            with self.subTest(value=value):
                lane = copy.deepcopy(self.lane)
                for record in (lane['artifact'], *lane['receipts'].values()):
                    record['contract_sha256'] = value
                row = self.view(lane=lane)
                self.assertFalse(row['ready_to_merge'])
                self.assertFalse(row['engineering_done'])
                self.assertEqual(row['roles']['reviewer']['state'], 'unknown')
                self.assertEqual(row['roles']['qa']['state'], 'unknown')

    def test_malformed_receipt_types_cannot_preserve_acceptance(self):
        self.assertTrue(self.view()['ready_to_merge'])
        for role in ('reviewer', 'qa'):
            for value in (True, 1.0, '1', None, 0, -1, 2):
                with self.subTest(role=role, generation=value):
                    lane = copy.deepcopy(self.lane)
                    lane['receipts'][role]['generation'] = value
                    row = self.view(lane=lane)
                    self.assertFalse(row['ready_to_merge'])
                    self.assertFalse(row['engineering_done'])
                    self.assertEqual(row['roles'][role]['state'], 'unknown')
            for field in ('gaps', 'decisions', 'failures', 'skipped', 'not_run'):
                for value in (None, False, 0, '', {}):
                    with self.subTest(role=role, field=field, value=value):
                        lane = copy.deepcopy(self.lane)
                        lane['receipts'][role][field] = value
                        row = self.view(lane=lane)
                        self.assertFalse(row['ready_to_merge'])
                        self.assertEqual(row['roles'][role]['state'], 'unknown')
                lane = copy.deepcopy(self.lane)
                lane['receipts'][role][field] = []
                self.assertTrue(self.view(lane=lane)['ready_to_merge'])

    def test_ready_requires_independent_current_head_receipts(self):
        self.assertTrue(self.view()['ready_to_merge'])
        self.assertFalse(self.view()['engineering_done'])
        self.assertTrue(self.view()['human_decision_required'])
        self.pr['head']='d'*40; self.pr['ci']['sha']='d'*40
        result=self.view()
        self.assertFalse(result['ready_to_merge'])
        self.assertIn('head_changed',result['blocked_reasons'])
        self.assertEqual(result['roles']['qa']['state'],'unknown')

    def test_stale_failed_and_wrong_actor_proofs_cannot_pass(self):
        for field,value in [('actor_id',self.config['owner']),('generation',2),('dirty',True),
                            ('outcome','fail'),('not_run',['required']),('contract_sha256','other')]:
            with self.subTest(field=field):
                lane=copy.deepcopy(self.lane);lane['receipts']['qa'][field]=value
                self.assertFalse(self.view(lane=lane)['ready_to_merge'])
        self.assertFalse(self.view(fresh=False)['ready_to_merge'])
        self.runs[1]['status']='running'
        self.assertFalse(self.view()['ready_to_merge'])

    def test_merged_needs_controller_mapping_and_exact_merge_ci(self):
        self.pr.update(state='MERGED',merge_sha=self.merge)
        self.lane.update(phase='done',integration={'method':'squash','head':self.head,'commit':self.merge,'parent':'d'*40,'tree':self.tree})
        self.issue['status']='done'
        self.assertFalse(self.view()['engineering_done'])
        self.pr['integration_ci']={'state':'success','sha':'e'*40}
        self.assertFalse(self.view()['engineering_done'])
        self.pr['integration_ci']['sha']=self.merge
        self.assertTrue(self.view()['engineering_done'])
        self.lane['phase']='awaiting_merge'
        self.assertFalse(self.view()['engineering_done'])

    def test_runtime_completion_or_tracker_status_is_not_engineering_done(self):
        self.issue['status']='in_progress'
        result=self.view()
        self.assertIn('tracker_active_without_runtime',result['blocked_reasons'])
        self.assertFalse(result['engineering_done']);self.assertFalse(result['ready_to_merge'])
        result=self.view(runs=[{'status':'completed'}])
        self.assertFalse(result['runtime_known']);self.assertFalse(result['engineering_done'])

    def test_offline_snapshot_has_no_writes_or_dispatch_and_no_raw_content(self):
        self.write('sync-health.json', {'state':'unavailable','error':'synthetic-private-value'})
        before=self.inventory()
        with patch.object(status.subprocess,'run',side_effect=AssertionError('No external command')):
            result=status.snapshot(root=self.root,state=self.state,now=self.now)
        self.assertEqual(self.inventory(),before)
        self.assertNotIn('synthetic-private-value',json.dumps(result))
        self.assertFalse(result['live_checked'])
        self.assertFalse(result['tasks'][0]['engineering_done'])
        self.assertFalse(result['scheduler']['new_admission'])

    def test_read_never_creates_missing_ledger_or_consumes_wal(self):
        (self.state/'ledger.sqlite3').unlink()
        before=self.inventory()
        result=status.snapshot(root=self.root,state=self.state)
        self.assertIn('ledger_unavailable_or_invalid',result['errors'])
        self.assertEqual(before,self.inventory())
        (self.state/'ledger.sqlite3-wal').write_text('synthetic')
        with self.assertRaises(ValueError):status.read_ledger(self.state)

    def test_old_or_future_poll_is_not_fresh(self):
        for value in ('2000-01-01T00:00:00Z','2999-01-01T00:00:00Z','bad'):
            self.write('sync-health.json',{'state':'fresh','observed_at':value})
            result=status.snapshot(root=self.root,state=self.state,now=self.now)
            self.assertEqual(result['poll']['state'],'unavailable_or_stale')

    def test_live_reads_are_allowlisted_and_paused_schedule_is_visible(self):
        queries=[]
        def reader(argv):
            queries.append(argv)
            if argv[0]!='multica':raise AssertionError(argv)
            tail=argv[5:]
            if tail[:2]==['issue','list']:return {'issues':[self.issue]}
            if tail[:2]==['issue','runs']:return self.runs
            if tail[:2]==['autopilot','list']:
                return {'autopilots':[{'id':self.config['autopilot'],'project_id':self.config['project'],'status':'paused'}]}
            raise AssertionError(argv)
        import github_sync
        class GH:
            def __init__(self,*a,**kw):pass
            def api(self,path):return {}
            def snapshot(other,pr):return self.pr
        before=self.inventory()
        with patch.object(github_sync,'GitHub',GH):
            result=status.snapshot(True,root=self.root,state=self.state,reader=reader)
        self.assertTrue(result['live_checked'],result['errors'])
        self.assertEqual(result['scheduler']['status'],'paused')
        self.assertFalse(result['scheduler']['handoffs'])
        self.assertEqual(before,self.inventory())
        self.assertEqual(len(queries),3)

    def test_failed_live_read_is_unknown_and_retains_no_raw_error(self):
        def reader(argv):raise ValueError('synthetic-private-value')
        result=status.snapshot(True,root=self.root,state=self.state,reader=reader)
        self.assertFalse(result['live_checked'])
        self.assertFalse(result['scheduler']['new_admission'])
        self.assertNotIn('synthetic-private-value',json.dumps(result))


    def test_ready_requires_live_in_review_tracker_before_verdict(self):
        self.assertTrue(self.view()['ready_to_merge'])
        for tracker in ('blocked','cancelled','unrecognized_status',None,'backlog','todo','in_progress','done','started_2','started_3'):
            with self.subTest(tracker=tracker):
                issue={**self.issue,'status':tracker}
                if tracker is None:issue.pop('status')
                result=self.view(issue=issue)
                self.assertFalse(result['ready_to_merge'])
                self.assertFalse(result['engineering_done'])
                self.assertTrue(result['blocked_reasons'])
                self.assertEqual(result['next_action'],'inspect_hold')

    def test_foreign_receipt_run_and_changed_contract_never_show_ready(self):
        lane=copy.deepcopy(self.lane);lane['receipts']['qa']['issue']='PIT-99'
        self.assertFalse(self.view(lane=lane)['ready_to_merge'])
        lane=copy.deepcopy(self.lane);lane['artifact']['issue']='PIT-99'
        self.assertFalse(self.view(lane=lane)['ready_to_merge'])
        runs=copy.deepcopy(self.runs);runs[0]['issue_id']='00000000-0000-0000-0000-000000000099'
        self.assertFalse(self.view(runs=runs)['ready_to_merge'])
        for field,value in [('description','Changed acceptance'),('description',None),('id','00000000-0000-0000-0000-000000000099')]:
            with self.subTest(field=field,value=value):
                result=self.view(issue={**self.issue,field:value})
                self.assertFalse(result['ready_to_merge']);self.assertTrue(result['blocked_reasons'])

    def test_active_extra_run_and_non_main_pr_hold_completed_receipts(self):
        runs=copy.deepcopy(self.runs)+[{'id':'00000000-0000-0000-0000-000000000008',
            'issue_id':self.issue['id'],'agent_id':self.config['qa'],'status':'running'}]
        self.assertIn('runtime_phase_conflict',self.view(runs=runs)['blocked_reasons'])
        self.assertFalse(self.view(runs=runs)['ready_to_merge'])
        result=self.view(pr={**self.pr,'base':'other'})
        self.assertFalse(result['ready_to_merge']);self.assertIn('pr_base_mismatch',result['blocked_reasons'])

    def test_duplicate_runtime_identity_cannot_pass(self):
        self.runs.append(copy.deepcopy(self.runs[0]))
        view=self.view()
        self.assertFalse(view['runtime_known']);self.assertFalse(view['ready_to_merge'])
        self.assertEqual(view['roles']['reviewer']['state'],'unknown')

    def test_activation_missing_commit_is_not_valid(self):
        self.write('activation.json',{'verified':True,'task_lanes':1,'source_fingerprint':status.fingerprint(self.root)})
        self.assertEqual(status.activation_state(self.root,self.state)['state'],'stale')

    def test_manual_infra_pr_is_visible_without_faking_controller_acceptance(self):
        issue={**self.issue,'metadata':{'pr_number':1,'pr_url':'https://github.com/'+self.policy['repository']+'/pull/1'}}
        def reader(argv):
            tail=argv[5:]
            if tail[:2]==['issue','list']:return {'issues':[issue]}
            if tail[:2]==['issue','runs']:return self.runs
            if tail[:2]==['autopilot','list']:return {'autopilots':[{'id':self.config['autopilot'],'project_id':self.config['project'],'status':'paused'}]}
            raise AssertionError(argv)
        import github_sync
        class GH:
            def __init__(self,*a,**kw):pass
            def api(other,path):
                return {'number':1,'title':'PIT-1: infra','head':{'ref':'codex/pit-1-infra','repo':{}},'base':{'repo':{'full_name':self.policy['repository']}}}
            def snapshot(other,raw):return self.pr
        with patch.object(status,'read_ledger',return_value=({},0)),patch.object(github_sync,'GitHub',GH):
            result=status.snapshot(True,root=self.root,state=self.state,reader=reader)
        self.assertTrue(result['live_checked'],result['errors'])
        row=result['tasks'][0];self.assertEqual(row['pr'],1);self.assertEqual(row['ci'],'success')
        self.assertFalse(row['ready_to_merge']);self.assertFalse(row['engineering_done'])
        self.assertIn('not_controlled_or_phase_unknown',row['blocked_reasons'])

    def test_late_invalid_task_revokes_earlier_ready_display(self):
        import github_sync
        second={**self.issue,'identifier':'PIT-2','id':'00000000-0000-0000-0000-000000000004'}
        def reader(argv):
            tail=argv[5:]
            if tail[:2]==['issue','list']:return {'issues':[self.issue,second]}
            if tail[:2]==['issue','runs']:return self.runs
            if tail[:2]==['autopilot','list']:return {'autopilots':[{'id':self.config['autopilot'],'project_id':self.config['project'],'status':'paused'}]}
            raise AssertionError(argv)
        class GH:
            def __init__(self,*a,**kw):pass
            def api(other,path):return {}
            def snapshot(other,raw):return self.pr
        lanes={'PIT-1':self.lane,'PIT-2':{'issue':'PIT-2','artifact':[]}}
        with patch.object(status,'read_ledger',return_value=(lanes,0)),patch.object(github_sync,'GitHub',GH):
            result=status.snapshot(True,root=self.root,state=self.state,reader=reader)
        self.assertFalse(result['live_checked'])
        self.assertFalse(result['tasks'][0]['ready_to_merge'])
        self.assertEqual(result['tasks'][0]['roles']['qa']['state'],'unknown')

    def test_admission_pause_keeps_handoff_and_maintenance_stops_all(self):
        import serial
        from unittest.mock import Mock
        ctl=serial.Serial.__new__(serial.Serial);ctl.c=self.config;ctl.root=self.state;ctl.policy=self.policy
        ctl.db=sqlite3.connect(self.state/'ledger.sqlite3');self.addCleanup(ctl.db.close)
        ctl.refresh=Mock();ctl.require_enabled=Mock();ctl.drain=Mock(return_value=['existing_handoff'])
        ctl.observation={'observed_at':self.now.isoformat(),'writes':0}
        result=ctl.tick(True)
        self.assertEqual(result['transitions'],['existing_handoff'])
        self.assertEqual(result['dispatch']['started'],[])
        self.assertEqual(result['dispatch']['held']['admission'],'admission_paused')
        ctl.drain.assert_called_once_with(True)
        self.write('control.json',{'mode':'maintenance','source_fingerprint':status.fingerprint(self.root)})
        ctl.refresh.reset_mock();ctl.drain.reset_mock()
        self.assertIn('held',ctl.tick(True))
        ctl.refresh.assert_not_called();ctl.drain.assert_not_called()


if __name__ == '__main__':
    unittest.main()
