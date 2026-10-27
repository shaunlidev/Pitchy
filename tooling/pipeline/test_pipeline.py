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

    def test_live_drift_and_missing_association_are_visible(self):
        policy = {**json.loads((ROOT / 'tooling/pipeline/policy.json').read_text()), 'mode':'serial_pr_foundation', 'migration_prs':[1,2,3], 'migration_base':'codex/pit-30-git-baseline'}
        prs = [{'number': 2, 'state': 'OPEN', 'baseRefName': 'main', 'statusCheckRollup': []}]
        findings = status.reconcile(policy, prs, [{'status': 'active'}], [], {'PIT-47': {'pull_requests': []}})
        self.assertEqual(len(findings), 5)
        prs[0].update(baseRefName=policy['migration_base'], statusCheckRollup=[{'name': 'PR gate', 'conclusion': 'SUCCESS'}])
        self.assertEqual(status.reconcile(policy, prs, [], [{'resource_ref': {'execution_mode': 'worktree'}}], {'PIT-47': {'pull_requests': [1]}}), [])

    def test_unavailable_live_query_is_an_error_not_pass(self):
        with patch.object(status, 'read_json', side_effect=RuntimeError('unavailable')):
            result = status.snapshot(live=True)
        self.assertFalse(result['live_checked'])
        self.assertEqual(len(result['errors']), 7)

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


if __name__ == '__main__':
    unittest.main()
