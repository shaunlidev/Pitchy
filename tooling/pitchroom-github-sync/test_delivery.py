import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import delivery

class PushSafety(unittest.TestCase):
    def test_manual_merge_sources_are_exact_and_still_content_scanned(self):
        for path in ['tooling/pipeline/operator_merge.py', 'tooling/pipeline/test_operator_merge.py']:
            self.assertTrue(delivery.allowed_path(path), path)
            with self.assertRaises(ValueError):
                delivery.check(path, ('sk-' + 'a' * 32).encode())
        for path in ['tooling/pipeline/operator_merge.py.bak',
                     'tooling/pipeline/test_operator_merge.py.json',
                     'tooling/pipeline/operator_merge_private.py',
                     'tooling/pipeline/operator_merge/receipt.json',
                     'tooling/pipeline/manual-merges/PIT-53.json',
                     '.state/pipeline/manual-merges/PIT-53.json',
                     'tooling/pipeline/unreviewed.py']:
            self.assertFalse(delivery.allowed_path(path), path)

    def test_qa_skill_source_paths_are_exact_and_runtime_evidence_stays_blocked(self):
        for path in ['docs/development/QA_SKILLS.md', 'tooling/pipeline/agent_instructions.py', 'tooling/pipeline/test_agent_instructions.py', 'tooling/pipeline/skills/pitchroom-qa-pstack/SKILL.md']:
            self.assertTrue(delivery.allowed_path(path), path)
        for path in ['docs/development/QA_SKILLS-private.md',
                     'tooling/pipeline/skills/pitchroom-qa-pstack/raw-qa.json',
                     'tooling/pipeline/skills/other/SKILL.md',
                     'tooling/pipeline/agent_instructions.py.bak',
                     'tooling/pipeline/.pipeline-local/qa.json']:
            self.assertFalse(delivery.allowed_path(path), path)

    def test_main_deletion_and_non_task_destinations_refused(self):
        for sha, ref in [('a'*40,'refs/heads/main'),('0'*40,'refs/heads/codex/pit-47-safe'),('a'*40,'refs/tags/release'),('a'*40,'refs/heads/feature')]:
            with self.assertRaises(ValueError): delivery.safe_destination(sha,ref)
        delivery.safe_destination('a'*40,'refs/heads/codex/pit-47-safe')

    def test_wrong_remote_and_force_update_refused_before_network(self):
        with self.assertRaises(ValueError): delivery.hook('other',delivery.URL,[])
        with patch.object(delivery.subprocess,'run',return_value=subprocess.CompletedProcess([],1)):
            with self.assertRaisesRegex(ValueError,'Non-fast-forward'):
                delivery.hook('origin',delivery.URL,[f"HEAD {'a'*40} refs/heads/codex/pit-47-safe {'b'*40}\n"])

    def test_all_history_scanned_and_public_destination_refused(self):
        with patch.object(delivery,'git',return_value='first\nsecond'),patch.object(delivery,'audit',return_value=3) as audit,patch.object(delivery.subprocess,'check_output',return_value='{"visibility":"PUBLIC","nameWithOwner":"shaunlidev/pitchroom"}'):
            with self.assertRaisesRegex(ValueError,'PRIVATE'):
                delivery.hook('origin',delivery.URL,[f"HEAD {'a'*40} refs/heads/codex/pit-47-safe {'0'*40}\n"])
            self.assertEqual(set(audit.call_args.args[0]),{'first','second','a'*40})

    def test_real_git_safe_source_secret_history_and_symlink(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory);original=subprocess.check_output
            def g(*args):return original(['git',*args],cwd=root,text=True).strip()
            g('init','-b','main');g('config','user.name','Synthetic');g('config','user.email','synthetic@example.invalid')
            policy=root/'tooling/pitchroom-github-sync/allowed-files.json';policy.parent.mkdir(parents=True);policy.write_text('[]')
            p=root/'pitchroom-app/apps/web/example.ts';p.parent.mkdir(parents=True);p.write_text('export const value=1;')
            g('add','.');g('commit','-m','Synthetic safe');safe=g('rev-parse','HEAD')
            def output(argv,**kwargs):return original(argv,cwd=root,**kwargs)
            with patch.object(delivery.subprocess,'check_output',side_effect=output):
                self.assertEqual(delivery.audit([safe]),2)
                secret='sk-'+'a'*32;p.write_text(secret);g('add','.');g('commit','-m','Synthetic unsafe intermediate');unsafe=g('rev-parse','HEAD')
                p.write_text('export const value=2;');g('add','.');g('commit','-m','Synthetic clean head')
                with self.assertRaises(ValueError) as caught:delivery.audit([unsafe,g('rev-parse','HEAD')])
                self.assertNotIn(secret,str(caught.exception))
                p.unlink();p.symlink_to('outside');g('add','.');g('commit','-m','Synthetic symlink')
                with self.assertRaisesRegex(ValueError,'mode'):delivery.audit([g('rev-parse','HEAD')])

    def test_runtime_directories_refuse_source_files_even_when_reviewed(self):
        for directory in ['test-results','playwright-report','.pitchroom','.gstack','.multica','.pipeline-local','.pipeline-artifact','.artifacts','.local','.next-qa','node_modules','dist','build','archive','.trash','screenshots','recordings','artifacts','evidence','logs','uploads','storage','sessions','cache','tmp','temp','coverage','.unknown-runtime']:
            for extension in ['ts','js']:
                path=f'pitchroom-app/apps/web/{directory}/runtime.{extension}'
                self.assertFalse(delivery.allowed_path(path,{path}),path)

    def test_private_data_and_unapproved_documents_excluded(self):
        for path in ['.multica/context.json','pitchroom-app/docs/participant.md','pitchroom-v6/evidence/result.json','data.sqlite','pitchroom-app/apps/web/private.json','pitchroom-app/packages/domain/customer.md']:
            self.assertFalse(delivery.allowed_path(path))
        from sync import check
        for path in ['pitchroom-app/.env.local','pitchroom-app/packages/data.sqlite','pitchroom-app/apps/web/data.db']:
            with self.assertRaises(ValueError):check(path,b'synthetic')



class ReviewedEvalSourceSafety(unittest.TestCase):
    def test_only_five_exact_paths_are_exempted(self):
        paths = {'pitchroom-app/docs/evals/task-acceptance-protocol.md'} | {
            f'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/{name}'
            for name in ['case.json', 'materials.json', 'oracle.json', 'task.md']
        }
        self.assertEqual(set(delivery.REVIEWED_EVAL_SOURCES), paths)
        for path in paths:
            self.assertTrue(delivery.allowed_path(path), path)
            self.assertRegex(delivery.REVIEWED_EVAL_SOURCES[path], r'^[a-f0-9]{64}$')
        for path in [
            'pitchroom-app/docs/evals/another-contract.md',
            'pitchroom-app/docs/evals/participant.md',
            'pitchroom-app/docs/evals/task-acceptance-protocol.md.bak',
            'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r2/materials.json',
            'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/participant.json',
            'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/raw-qa.json',
            'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/other.json',
        ]:
            self.assertFalse(delivery.allowed_path(path), path)

    def test_real_git_checks_all_pinned_content_history_and_file_modes(self):
        import hashlib
        source = 'pitchroom-app/docs/evals/task-acceptance-protocol.md'
        fixture = 'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/materials.json'
        approved = b'# Synthetic reviewed product requirements\n'
        receipts = {source: hashlib.sha256(approved).hexdigest(), fixture: hashlib.sha256(approved).hexdigest()}
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = subprocess.check_output
            def g(*args):
                return original(['git', *args], cwd=root, text=True).strip()
            def commit(message):
                g('add', '.'); g('commit', '-m', message)
                return g('rev-parse', 'HEAD')
            def output(argv, **kwargs):
                return original(argv, cwd=root, **kwargs)
            g('init', '-b', 'main'); g('config', 'user.name', 'Synthetic'); g('config', 'user.email', 'synthetic@example.invalid')
            policy = root/'tooling/pitchroom-github-sync/allowed-files.json'
            policy.parent.mkdir(parents=True); policy.write_text('[]')
            for path in [source, fixture]:
                p = root/path; p.parent.mkdir(parents=True, exist_ok=True); p.write_bytes(approved)
            safe = commit('Synthetic exact receipts')
            with patch.object(delivery, 'REVIEWED_EVAL_SOURCES', receipts), patch.object(delivery.subprocess, 'check_output', side_effect=output):
                self.assertEqual(delivery.audit([safe]), 3)
                for path in [source, fixture]:
                    with self.subTest(path=path):
                        p = root/path
                        p.write_bytes(b'Customer records under an approved filename.\n')
                        unsafe = commit('Synthetic changed approved path')
                        p.write_bytes(approved); clean = commit('Synthetic restored head')
                        self.assertEqual(delivery.audit([clean]), 3)
                        with self.assertRaisesRegex(ValueError, 'content changed'):
                            delivery.audit([safe, unsafe, clean])
                        p.unlink(); p.symlink_to('outside')
                        symlink = commit('Synthetic approved path symlink')
                        with self.assertRaisesRegex(ValueError, 'mode'):
                            delivery.audit([symlink])
                        p.unlink(); p.write_bytes(approved); commit('Synthetic restore regular file')

    def test_exact_receipt_does_not_bypass_secret_scan(self):
        import hashlib
        path = 'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/materials.json'
        secret = ('sk-' + 'a'*32).encode()
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); original = subprocess.check_output
            def g(*args):
                return original(['git', *args], cwd=root, text=True).strip()
            g('init', '-b', 'main'); g('config', 'user.name', 'Synthetic'); g('config', 'user.email', 'synthetic@example.invalid')
            policy = root/'tooling/pitchroom-github-sync/allowed-files.json'
            policy.parent.mkdir(parents=True); policy.write_text('[]')
            p = root/path; p.parent.mkdir(parents=True); p.write_bytes(secret)
            g('add', '.'); g('commit', '-m', 'Synthetic secret control')
            def output(argv, **kwargs):
                return original(argv, cwd=root, **kwargs)
            with patch.object(delivery, 'REVIEWED_EVAL_SOURCES', {path: hashlib.sha256(secret).hexdigest()}), patch.object(delivery.subprocess, 'check_output', side_effect=output):
                with self.assertRaises(ValueError) as caught:
                    delivery.audit([g('rev-parse', 'HEAD')])
                self.assertIn('Possible credential', str(caught.exception))
                self.assertNotIn(secret.decode(), str(caught.exception))


class ReviewedPortfolioSafety(unittest.TestCase):
    def test_only_the_eight_reviewed_files_are_allowed(self):
        names = {'README.md', 'architecture.md', 'case-study.md',
                 'contribution-and-interview.md', 'demo.md',
                 'evidence-index.json', 'failure-analysis.md', 'verification.md'}
        expected = {f'docs/portfolio/{name}' for name in names}
        self.assertEqual(set(delivery.REVIEWED_PORTFOLIO_SOURCES), expected)
        for path in expected:
            self.assertTrue(delivery.allowed_path(path), path)
            self.assertRegex(delivery.REVIEWED_PORTFOLIO_SOURCES[path], r'^[a-f0-9]{64}$')
        for path in ['docs/portfolio/another.md', 'docs/portfolio/participant.md',
                     'docs/portfolio/raw-qa.json', 'docs/portfolio/demo.md.bak',
                     'docs/portfolio/evidence/output.json',
                     'docs/portfolio/.env.local', 'docs/private.md']:
            self.assertFalse(delivery.allowed_path(path), path)

    def test_real_git_pins_content_history_modes_and_still_scans_secrets(self):
        import hashlib
        source = 'docs/portfolio/case-study.md'
        approved = b'# Synthetic portfolio review\n'
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            original = subprocess.check_output
            def g(*args):
                return original(['git', *args], cwd=root, text=True).strip()
            def commit(message):
                g('add', '.'); g('commit', '-m', message)
                return g('rev-parse', 'HEAD')
            def output(argv, **kwargs):
                return original(argv, cwd=root, **kwargs)
            g('init', '-b', 'main'); g('config', 'user.name', 'Synthetic')
            g('config', 'user.email', 'synthetic@example.invalid')
            policy = root/'tooling/pitchroom-github-sync/allowed-files.json'
            policy.parent.mkdir(parents=True); policy.write_text('[]')
            p = root/source; p.parent.mkdir(parents=True); p.write_bytes(approved)
            safe = commit('Synthetic approved portfolio')
            with patch.object(delivery, 'REVIEWED_PORTFOLIO_SOURCES',
                              {source: hashlib.sha256(approved).hexdigest()}), \
                 patch.object(delivery.subprocess, 'check_output', side_effect=output):
                self.assertEqual(delivery.audit([safe]), 2)
                p.write_bytes(b'Unreviewed changed text.\n')
                changed = commit('Synthetic changed portfolio')
                p.write_bytes(approved); restored = commit('Synthetic restored portfolio')
                self.assertEqual(delivery.audit([restored]), 2)
                with self.assertRaisesRegex(ValueError, 'content changed'):
                    delivery.audit([safe, changed, restored])
                p.unlink(); p.symlink_to('outside')
                link = commit('Synthetic symlink')
                with self.assertRaisesRegex(ValueError, 'mode'):
                    delivery.audit([link])
                p.unlink()
                secret = ('sk-' + 'a'*32).encode()
                p.write_bytes(secret); unsafe = commit('Synthetic secret control')
                with patch.object(delivery, 'REVIEWED_PORTFOLIO_SOURCES',
                                  {source: hashlib.sha256(secret).hexdigest()}):
                    with self.assertRaises(ValueError) as caught:
                        delivery.audit([unsafe])
                    self.assertIn('Possible credential', str(caught.exception))
                    self.assertNotIn(secret.decode(), str(caught.exception))


if __name__ == '__main__':
    unittest.main()
