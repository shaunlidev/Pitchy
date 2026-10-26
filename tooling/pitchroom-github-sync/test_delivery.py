import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
import delivery

class PushSafety(unittest.TestCase):
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
            p=root/'pitchroom-app/apps/web/example.ts';p.parent.mkdir(parents=True);p.write_text('export const value=1;')
            g('add','.');g('commit','-m','Synthetic safe');safe=g('rev-parse','HEAD')
            def output(argv,**kwargs):return original(argv,cwd=root,**kwargs)
            with patch.object(delivery.subprocess,'check_output',side_effect=output):
                self.assertEqual(delivery.audit([safe]),1)
                secret='sk-'+'a'*32;p.write_text(secret);g('add','.');g('commit','-m','Synthetic unsafe intermediate');unsafe=g('rev-parse','HEAD')
                p.write_text('export const value=2;');g('add','.');g('commit','-m','Synthetic clean head')
                with self.assertRaises(ValueError) as caught:delivery.audit([unsafe,g('rev-parse','HEAD')])
                self.assertNotIn(secret,str(caught.exception))
                p.unlink();p.symlink_to('outside');g('add','.');g('commit','-m','Synthetic symlink')
                with self.assertRaisesRegex(ValueError,'mode'):delivery.audit([g('rev-parse','HEAD')])

    def test_private_data_and_unapproved_documents_excluded(self):
        for path in ['.multica/context.json','pitchroom-app/docs/participant.md','pitchroom-v6/evidence/result.json','data.sqlite']:
            self.assertFalse(delivery.allowed_path(path))
        from sync import check
        for path in ['pitchroom-app/.env.local','pitchroom-app/packages/data.sqlite','pitchroom-app/apps/web/data.db']:
            with self.assertRaises(ValueError):check(path,b'synthetic')

if __name__=='__main__':unittest.main()
