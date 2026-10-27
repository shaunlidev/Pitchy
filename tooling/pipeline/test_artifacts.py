import concurrent.futures
from pathlib import Path
import subprocess
import tempfile
import unittest

from artifacts import ArtifactError, checkpoint, common_dir, has_ancestor, materialize, prepare_dependencies, verify_clean_tree, verify_dependencies


def git(repo, *args):
    result = subprocess.run(["git", "-C", str(repo), *args], capture_output=True, check=True)
    return result.stdout.decode().strip()


class ArtifactTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="pitchroom-artifacts-")
        self.root = Path(self.temp.name).resolve()
        self.repo = self.root / "source"
        self.repo.mkdir()
        git(self.repo, "init", "-q")
        git(self.repo, "config", "user.name", "Synthetic Artifact Test")
        git(self.repo, "config", "user.email", "artifact-test@example.invalid")
        (self.repo / "shared.txt").write_text("base shared\n")
        (self.repo / "unrelated.txt").write_text("base unrelated\n")
        (self.repo / ".gitignore").write_text("ignored-output/\nnode_modules/\n")
        git(self.repo, "add", "shared.txt", "unrelated.txt", ".gitignore")
        git(self.repo, "commit", "-qm", "Synthetic baseline")
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.tree = git(self.repo, "rev-parse", "HEAD^{tree}")
        (self.repo / "shared.txt").write_text("existing stash text\n")
        git(self.repo, "stash", "push", "-qm", "synthetic existing stash")
        (self.repo / "shared.txt").write_text("original user unstaged\n")
        (self.repo / "unrelated.txt").write_text("original user staged\n")
        git(self.repo, "add", "unrelated.txt")
        (self.repo / "untracked-user.txt").write_text("original user untracked\n")
        self.original = self.source_state()

    def tearDown(self):
        self.temp.cleanup()

    def source_state(self):
        index = Path(git(self.repo, "rev-parse", "--git-path", "index"))
        if not index.is_absolute():
            index = self.repo / index
        return {"head": git(self.repo, "rev-parse", "HEAD"), "index": index.read_bytes(),
                "stash": git(self.repo, "stash", "list"),
                "shared": (self.repo / "shared.txt").read_bytes(),
                "other": (self.repo / "unrelated.txt").read_bytes(),
                "untracked": (self.repo / "untracked-user.txt").read_bytes()}

    def worktree(self, name):
        dest = self.root / name
        git(self.repo, "worktree", "add", "--detach", str(dest), self.base)
        return dest

    def test_two_parallel_tasks_isolate_same_filename_and_preserve_user_state(self):
        a, b = self.worktree("issue-a"), self.worktree("issue-b")
        (a / "shared.txt").write_text("task A\n")
        (b / "shared.txt").write_text("task B\n")
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            futures = [pool.submit(checkpoint, a, "PIT-1", 1, ["shared.txt"], repository=self.repo),
                       pool.submit(checkpoint, b, "PIT-2", 1, ["shared.txt"], repository=self.repo)]
            da, db = [f.result() for f in futures]
        self.assertNotEqual(da["commit"], db["commit"])
        self.assertNotEqual(da["tree"], db["tree"])
        self.assertEqual(git(a, "show", "HEAD:shared.txt"), "task A")
        self.assertEqual(git(b, "show", "HEAD:shared.txt"), "task B")
        self.assertEqual(self.source_state(), self.original)
        self.assertTrue(verify_clean_tree(a, da["tree"]))
        self.assertTrue(verify_clean_tree(b, db["tree"]))

    def test_review_and_qa_materialize_exact_delivery_without_changing_native_root(self):
        dev = self.worktree("dev")
        (dev / "shared.txt").write_text("delivered exact version\n")
        delivered = checkpoint(dev, "PIT-3", 1, ["shared.txt"], repository=self.repo)
        native = self.worktree("reviewer-native")
        native_head = git(native, "rev-parse", "HEAD")
        reviewer = materialize(self.repo, delivered["commit"], native / "review-artifact")
        qa_native = self.worktree("qa-native")
        qa = materialize(self.repo, delivered["commit"], qa_native / "qa-artifact")
        self.assertEqual(reviewer["commit"], qa["commit"])
        self.assertEqual(reviewer["tree"], delivered["tree"])
        self.assertEqual(qa["tree"], delivered["tree"])
        self.assertEqual(git(native, "rev-parse", "HEAD"), native_head)
        self.assertEqual((native / "shared.txt").read_text(), "base shared\n")
        self.assertEqual(self.source_state(), self.original)

    def test_checkpoint_only_declared_files_and_preserves_unrelated_staging(self):
        work = self.worktree("declared")
        (work / "shared.txt").write_text("declared task edit\n")
        (work / "unrelated.txt").write_text("unrelated staged edit\n")
        git(work, "add", "unrelated.txt")
        result = checkpoint(work, "PIT-4", 1, ["shared.txt"], repository=self.repo)
        self.assertEqual(result["changed_paths"], ["shared.txt"])
        self.assertEqual(git(work, "show", "HEAD:unrelated.txt"), "base unrelated")
        self.assertEqual(git(work, "show", ":unrelated.txt"), "unrelated staged edit")
        self.assertEqual(git(work, "diff", "--cached", "--name-only"), "unrelated.txt")
        with self.assertRaises(ArtifactError):
            verify_clean_tree(work, result["tree"])
        self.assertEqual(self.source_state(), self.original)

    def test_new_and_deleted_files_are_checkpointed(self):
        work = self.worktree("create-delete")
        (work / "shared.txt").unlink()
        (work / "new.txt").write_text("new task file\n")
        result = checkpoint(work, "PIT-5", 1, ["shared.txt", "new.txt"], repository=self.repo)
        self.assertEqual(set(result["changed_paths"]), {"shared.txt", "new.txt"})
        self.assertEqual(git(work, "show", "HEAD:new.txt"), "new task file")
        self.assertTrue(verify_clean_tree(work, result["tree"]))

    def test_no_change_returns_existing_immutable_commit(self):
        work = self.worktree("no-change")
        result = checkpoint(work, "PIT-6", 1, ["shared.txt"], repository=self.repo)
        self.assertEqual(result["commit"], self.base)
        self.assertEqual(result["changed_paths"], [])

    def test_wrong_repository_and_original_working_directory_refused(self):
        with self.assertRaises(ArtifactError):
            checkpoint(self.repo, "PIT-7", 1, ["shared.txt"], repository=self.repo)
        other = self.root / "other"
        other.mkdir()
        git(other, "init", "-q")
        with self.assertRaises(ArtifactError):
            checkpoint(self.worktree("wrong-repo"), "PIT-7", 1, ["shared.txt"], repository=other)
        self.assertEqual(self.source_state(), self.original)

    def test_sensitive_control_raw_evidence_and_traversal_paths_refused(self):
        work = self.worktree("sensitive")
        paths = [".env", ".env.local", "app/.env.example", "archive/file.txt", ".trash/file",
                 ".multica/context.json", "tooling/multica-pipeline/config.json", "x/.state/data",
                 "x/.artifacts/raw.json", "auth.json", "../outside", "/absolute", "a/../shared.txt",
                 "./shared.txt", "a//b", "a\\b", "node_modules/package.json"]
        for path in paths:
            with self.subTest(path=path), self.assertRaises(ArtifactError):
                checkpoint(work, "PIT-8", 1, [path], repository=self.repo)
        self.assertEqual(git(work, "rev-parse", "HEAD"), self.base)

    def test_symlink_files_and_ancestor_directories_refused(self):
        work = self.worktree("symlinks")
        outside = self.root / "outside"
        outside.mkdir(); (outside / "secret.txt").write_text("synthetic secret")
        (work / "link.txt").symlink_to(outside / "secret.txt")
        (work / "link-dir").symlink_to(outside, target_is_directory=True)
        for path in ("link.txt", "link-dir/secret.txt"):
            with self.subTest(path=path), self.assertRaises(ArtifactError):
                checkpoint(work, "PIT-9", 1, [path], repository=self.repo)
        self.assertEqual(git(work, "rev-parse", "HEAD"), self.base)

    def test_dirty_wrong_tree_and_untracked_verification_refused(self):
        work = self.worktree("dirty")
        self.assertTrue(verify_clean_tree(work, self.tree))
        with self.assertRaises(ArtifactError):
            verify_clean_tree(work, "0" * 40)
        (work / "untracked.txt").write_text("not in artifact")
        with self.assertRaises(ArtifactError):
            verify_clean_tree(work, self.tree)
        (work / "untracked.txt").unlink()
        (work / "shared.txt").write_text("changed after checking out")
        with self.assertRaises(ArtifactError):
            verify_clean_tree(work, self.tree)

    def test_ignored_test_output_does_not_change_delivery(self):
        work = self.worktree("ignored")
        (work / "ignored-output").mkdir()
        (work / "ignored-output" / "log.txt").write_text("test log")
        self.assertTrue(verify_clean_tree(work, self.tree))

    def test_materialize_refuses_existing_traversal_and_symlink_destinations(self):
        occupied = self.root / "occupied"
        occupied.mkdir()
        alias = self.root / "alias"
        alias.symlink_to(occupied, target_is_directory=True)
        for target in (occupied, self.root / "nested" / ".." / "escaped", alias / "child"):
            with self.subTest(target=str(target)), self.assertRaises(ArtifactError):
                materialize(self.repo, self.base, target)
        self.assertEqual(self.source_state(), self.original)

    def test_only_full_commit_id_accepted(self):
        for value in ("HEAD", "main", self.base[:8], "--help", "f" * 39):
            with self.subTest(value=value), self.assertRaises(ArtifactError):
                materialize(self.repo, value, self.root / "invalid-id")

    def test_dependent_base_requires_real_prerequisite_ancestry(self):
        a = self.worktree("prereq")
        (a / "shared.txt").write_text("prerequisite\n")
        delivered = checkpoint(a, "PIT-10", 1, ["shared.txt"], repository=self.repo)
        self.assertFalse(has_ancestor(self.repo, delivered["commit"], self.base))
        self.assertTrue(has_ancestor(self.repo, self.base, delivered["commit"]))
        self.assertTrue(has_ancestor(self.repo, delivered["commit"], delivered["commit"]))

    def test_malformed_issue_generation_and_declared_directories_refused(self):
        work = self.worktree("bad-input")
        for issue_key, gen, paths in (("PIT-0", 1, ["shared.txt"]), ("PIT-1", True, ["shared.txt"]),
                                       ("PIT-1", 0, ["shared.txt"]), ("PIT-1", 1, []),
                                       ("PIT-1", 1, ["."])):
            with self.subTest(issue=issue_key, generation=gen), self.assertRaises(ArtifactError):
                checkpoint(work, issue_key, gen, paths, repository=self.repo)

    def fake_dependencies(self):
        domain = self.repo / "pitchroom-app/packages/domain"
        domain.mkdir(parents=True)
        (domain / "index.js").write_text("module.exports = 'isolated domain';\n")
        git(self.repo, "add", "pitchroom-app/packages/domain/index.js")
        git(self.repo, "commit", "--only", "-qm", "Synthetic workspace source", "--", "pitchroom-app/packages/domain/index.js")
        self.base = git(self.repo, "rev-parse", "HEAD")
        self.original = self.source_state()
        store = self.repo / "pitchroom-app/node_modules/.pnpm/lib@1/node_modules/lib"
        store.mkdir(parents=True)
        (store / "index.js").write_text("module.exports = 'existing installed dependency';\n")
        (store / "cli.js").write_text("#!/usr/bin/env node\n")
        (store / ".env.production").write_text("SYNTHETIC_DO_NOT_COPY=value\n")
        (store / ".ENV.local").write_text("SYNTHETIC_DO_NOT_COPY=value\n")
        (self.repo / "pitchroom-app/node_modules/lib").symlink_to(".pnpm/lib@1/node_modules/lib", target_is_directory=True)
        web = self.repo / "pitchroom-app/apps/web/node_modules"
        web.mkdir(parents=True)
        (web / "lib").symlink_to("../../../node_modules/.pnpm/lib@1/node_modules/lib", target_is_directory=True)
        (web / "@pitchroom").mkdir()
        (web / "@pitchroom/domain").symlink_to("../../../../packages/domain", target_is_directory=True)
        packages = domain / "node_modules"
        packages.mkdir()
        (packages / "lib").symlink_to("../../../node_modules/.pnpm/lib@1/node_modules/lib", target_is_directory=True)
        top = self.repo / "node_modules/tool"
        top.mkdir(parents=True)
        (top / "index.js").write_text("module.exports = 'top level installed tool';\n")
        return store

    def test_dependency_copy_keeps_workspace_resolution_inside_checkout_and_no_hardlinks(self):
        source = self.fake_dependencies()
        work = self.worktree("dependency-copy")
        result = prepare_dependencies(self.repo, work)
        self.assertEqual(len(result["roots"]), 4)
        self.assertFalse(result["installed"])
        self.assertFalse(result["hardlinked"])
        self.assertFalse(result["environment_files_copied"])
        copied = work / source.relative_to(self.repo)
        self.assertEqual((copied / "index.js").read_bytes(), (source / "index.js").read_bytes())
        self.assertNotEqual((copied / "index.js").stat().st_ino, (source / "index.js").stat().st_ino)
        self.assertFalse((copied / ".env.production").exists())
        self.assertFalse((copied / ".ENV.local").exists())
        resolved = (work / "pitchroom-app/apps/web/node_modules/@pitchroom/domain").resolve()
        self.assertEqual(resolved, work / "pitchroom-app/packages/domain")
        self.assertNotEqual(resolved, self.repo / "pitchroom-app/packages/domain")
        self.assertTrue((work / "pitchroom-app/apps/web/node_modules/lib").resolve().is_relative_to(work))
        self.assertTrue(verify_clean_tree(work, git(work, "rev-parse", "HEAD^{tree}")))
        self.assertEqual(self.source_state(), self.original)

    def test_runtime_test_caches_are_fresh_outputs_not_installed_package_identity(self):
        source = self.fake_dependencies()
        for name in (".vite", ".vitest-cache"):
            cache = self.repo / "pitchroom-app/node_modules" / name
            cache.mkdir(); (cache / "old-result.json").write_text("old runtime output")
        work = self.worktree("runtime-caches")
        expected = prepare_dependencies(self.repo, work)
        for name in (".vite", ".vitest-cache"):
            cache = work / "pitchroom-app/node_modules" / name
            self.assertFalse(cache.exists())
            cache.mkdir(); (cache / "new-result.json").write_text("new run output")
        self.assertTrue(verify_dependencies(work, expected))
        installed = work / source.relative_to(self.repo) / "index.js"
        installed.write_text("changed actual package")
        with self.assertRaises(ArtifactError): verify_dependencies(work, expected)
        self.assertEqual((source / "index.js").read_text(), "module.exports = 'existing installed dependency';\n")

    def test_runtime_cache_policy_keeps_nested_package_code_and_rejects_legacy_receipts(self):
        source = self.fake_dependencies()
        nested = source / ".vite"; nested.mkdir(); (nested / "code.js").write_text("package code")
        work = self.worktree("nested-code")
        expected = prepare_dependencies(self.repo, work)
        legacy = dict(expected); legacy.pop("fingerprint_policy", None)
        with self.assertRaises(ArtifactError): verify_dependencies(work, legacy)
        (work / nested.relative_to(self.repo) / "code.js").write_text("tampered package code")
        with self.assertRaises(ArtifactError): verify_dependencies(work, expected)

    def test_runtime_cache_symlink_cannot_point_outside_the_verification_checkout(self):
        self.fake_dependencies();work=self.worktree("cache-link")
        expected=prepare_dependencies(self.repo,work)
        (work/"pitchroom-app/node_modules/.vite").symlink_to(self.repo, target_is_directory=True)
        with self.assertRaises(ArtifactError): verify_dependencies(work,expected)

    def test_dependency_copy_rejects_external_absolute_and_escaping_relative_links(self):
        self.fake_dependencies()
        bad = self.repo / "node_modules/bad"
        for n, target in enumerate((str(self.repo / "shared.txt"), "../../outside")):
            bad.symlink_to(target)
            work = self.worktree("bad-deps-" + str(n))
            with self.assertRaises(ArtifactError):
                prepare_dependencies(self.repo, work)
            self.assertFalse((work / "node_modules").exists())
            bad.unlink()

    def test_dependency_copy_rejects_existing_destination_and_original_directory(self):
        self.fake_dependencies()
        work = self.worktree("existing-deps")
        (work / "node_modules").mkdir()
        with self.assertRaises(ArtifactError):
            prepare_dependencies(self.repo, work)
        with self.assertRaises(ArtifactError):
            prepare_dependencies(self.repo, self.repo)

    def test_dependency_copy_without_installation_fails_closed(self):
        work = self.worktree("missing-deps")
        with self.assertRaises(ArtifactError):
            prepare_dependencies(self.repo, work)

    def test_dependency_source_parent_symlink_is_refused_without_copying(self):
        work = self.worktree("source-link")
        outside = self.root / "external-install"
        (outside / "node_modules/pkg").mkdir(parents=True)
        (outside / "node_modules/pkg/index.js").write_text("external content")
        (self.repo / "pitchroom-app").symlink_to(outside, target_is_directory=True)
        with self.assertRaises(ArtifactError):
            prepare_dependencies(self.repo, work)
        self.assertFalse((work / "pitchroom-app").exists())


if __name__ == "__main__":
    unittest.main()
