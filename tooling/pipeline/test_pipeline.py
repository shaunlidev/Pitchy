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
    def test_live_drift_and_missing_association_are_visible(self):
        policy = json.loads((ROOT / 'tooling/pipeline/policy.json').read_text())
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
