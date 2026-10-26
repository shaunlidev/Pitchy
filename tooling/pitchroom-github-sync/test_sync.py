import importlib.util
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import json
import subprocess
import sys

spec = importlib.util.spec_from_file_location("sync", Path(__file__).with_name("sync.py"))
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)


class ExportSafety(unittest.TestCase):
    def test_preview_push_modify_and_delete_against_local_remote(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "workspace"
            root.mkdir()
            remote = Path(directory) / "remote.git"
            subprocess.run(["git", "init", "--bare", "-b", "main", str(remote)], check=True, capture_output=True)
            seed = Path(directory) / "seed"
            subprocess.run(["git", "clone", str(remote), str(seed)], check=True, capture_output=True)
            def seed_git(*args):
                return subprocess.check_output(["git", "-C", str(seed), *args], text=True)
            seed_git("config", "user.name", "Synthetic")
            seed_git("config", "user.email", "synthetic@example.invalid")
            (seed / "README.md").write_text("Synthetic repository")
            seed_git("add", ".")
            seed_git("commit", "-m", "Initial synthetic tree")
            seed_git("push", "origin", "main")
            helper = root / sync.HELPER
            helper.mkdir(parents=True)
            (helper / "allowed-files.json").write_text("[]")
            source = root / "pitchroom-app/apps/web/example.ts"
            source.parent.mkdir(parents=True)
            source.write_text("export const value = 1;")
            original_run = sync.run
            def command(*args, cwd=None):
                if args[0] == "gh":
                    return json.dumps({"nameWithOwner": sync.REPO, "visibility": "PRIVATE"})
                return original_run(*args, cwd=cwd or root)
            with patch.object(sync, "ROOT", root), patch.object(sync, "MIRROR", root / ".pitchroom-github"), patch.object(sync, "URL", str(remote)), patch.object(sync, "run", side_effect=command):
                with patch.object(sys, "argv", ["sync"]):
                    sync.main()
                self.assertFalse((sync.MIRROR / source.relative_to(root)).exists())
                with patch.object(sys, "argv", ["sync", "--push", "-m", "Synthetic source"]):
                    sync.main()
                self.assertEqual(sync.git("rev-parse", "HEAD"), sync.git("rev-parse", "origin/main"))
                source.unlink()
                with patch.object(sys, "argv", ["sync", "--push", "-m", "Synthetic deletion"]):
                    sync.main()
                self.assertNotIn("example.ts", sync.git("ls-tree", "-r", "--name-only", "HEAD"))

    def test_secret_values_are_blocked_without_echo(self):
        for value in ("sk-" + "a" * 32, "github_pat_" + "b" * 30):
            with self.assertRaises(ValueError) as caught:
                sync.check("pitchroom-app/apps/web/lib/example.ts", value.encode())
            self.assertNotIn(value, str(caught.exception))

    def test_json_credentials_and_remote_database_are_blocked(self):
        for text in (json.dumps({"apiKey": "a" * 30}), "postgres://user:example@private.example/db"):
            with self.assertRaises(ValueError):
                sync.check("pitchroom-app/packages/evals/config/example.json", text.encode())

    def test_local_placeholders_and_synthetic_tests_remain_valid(self):
        sync.check("pitchroom-app/.env.example", b"DATABASE_URL=postgres://pitchroom:pitchroom@127.0.0.1:54329/pitchroom\nOPENAI_API_KEY=\n")
        sync.check("pitchroom-app/apps/web/example.test.ts", b'apiKey: "offline-secret"')

    def test_data_and_binary_paths_blocked(self):
        for path in ("pitchroom-app/.env.local", "pitchroom-app/data.sqlite", "pitchroom-app/docs/participant.md", "pitchroom-app/key.pem"):
            with self.assertRaises(ValueError):
                sync.check(path, b"data")
        with self.assertRaises(ValueError):
            sync.check("pitchroom-app/apps/example.ts", b"\0")

    def test_new_source_added_data_excluded_deleted_file_removed(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "ROOT", Path(directory)):
            root = Path(directory)
            helper = root / sync.HELPER
            helper.mkdir(parents=True)
            (helper / "allowed-files.json").write_text(json.dumps(["pitchroom-app/apps/removed.ts"]))
            app = root / "pitchroom-app/apps/web"
            app.mkdir(parents=True)
            (app / "new.ts").write_text("export const value = 1;")
            (app / "private.json").write_text("{}")
            (app / ".env").write_text("private")
            (app / "node_modules").mkdir()
            (app / "node_modules/private.ts").write_text("private")
            result = sync.candidate()
            self.assertIn("pitchroom-app/apps/web/new.ts", result)
            self.assertNotIn("pitchroom-app/apps/web/private.json", result)
            self.assertNotIn("pitchroom-app/apps/removed.ts", result)
            self.assertFalse(any("node_modules" in p or p.endswith(".env") for p in result))

    def test_symlink_and_allowlist_escape_rejected(self):
        with tempfile.TemporaryDirectory() as directory, patch.object(sync, "ROOT", Path(directory)):
            root = Path(directory)
            helper = root / sync.HELPER
            helper.mkdir(parents=True)
            manifest = helper / "allowed-files.json"
            manifest.write_text(json.dumps(["../outside"]))
            with self.assertRaises(ValueError):
                sync.candidate()
            app = root / "pitchroom-app/apps"
            app.mkdir(parents=True)
            (app / "bad.ts").symlink_to(helper / "allowed-files.json")
            manifest.write_text(json.dumps(["pitchroom-app/apps/bad.ts"]))
            with self.assertRaises(ValueError):
                sync.candidate()


if __name__ == "__main__":
    unittest.main()
