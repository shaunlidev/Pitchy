"""Local Git delivery checkpoints and exact-version verification worktrees.

No command merges, pushes, cleans, stashes, or writes the source worktree.
Callers bind a production task to its canonical repository with ``repository=``.
"""
from __future__ import annotations

import os
import hashlib
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tempfile


class ArtifactError(RuntimeError):
    pass


_OID = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})\Z")
_ISSUE = re.compile(r"[A-Z][A-Z0-9]*-[1-9][0-9]*\Z")
_FORBIDDEN_PARTS = {
    ".git", ".multica", ".multica-round", ".trash", "archive", ".artifacts",
    "node_modules", ".state", ".aws", ".ssh", ".codex", ".claude",
    "playwright-report", "test-results", "browser-profile", "evidence",
}
_SECRET_NAMES = {"auth.json", "credentials.json", "secrets.json", "storage-state.json", "storagestate.json"}


def _git(directory, *args, env=None, input=None, check=True):
    clean_env = os.environ.copy()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR"):
        clean_env.pop(key, None)
    if env:
        clean_env.update(env)
    result = subprocess.run(
        ["git", "-C", str(directory), *args], input=input, capture_output=True,
        env=clean_env, timeout=60,
    )
    if check and result.returncode:
        # Avoid emitting user Git hooks/configuration or file contents into reports.
        raise ArtifactError("git operation failed: " + args[0])
    return result


def _text(directory, *args):
    return _git(directory, *args).stdout.decode().strip()


def common_dir(repository):
    """Return the canonical common Git directory, shared across owned worktrees."""
    repo = Path(repository).resolve(strict=True)
    value = _text(repo, "rev-parse", "--path-format=absolute", "--git-common-dir")
    return str(Path(value).resolve(strict=True))


def _root(workdir, repository=None):
    raw = Path(workdir)
    if raw.is_symlink():
        raise ArtifactError("worktree root must not be a symlink")
    root = raw.resolve(strict=True)
    if not root.is_dir() or Path(_text(root, "rev-parse", "--show-toplevel")).resolve() != root:
        raise ArtifactError("operation requires the exact worktree root")
    if _text(root, "rev-parse", "--is-bare-repository") != "false":
        raise ArtifactError("bare repositories are not task worktrees")
    if repository is not None:
        canonical = Path(repository).resolve(strict=True)
        if root == canonical:
            raise ArtifactError("checkpoint must not write the original repository")
        if common_dir(root) != common_dir(canonical):
            raise ArtifactError("task worktree belongs to another repository")
    return root


def _oid(value):
    if not isinstance(value, str) or not _OID.fullmatch(value):
        raise ArtifactError("a full immutable Git object ID is required")
    return value


def _commit(repo, value):
    value = _oid(value)
    resolved = _text(repo, "rev-parse", "--verify", "--end-of-options", value + "^{commit}")
    if resolved != value:
        raise ArtifactError("commit identity changed")
    return resolved


def _path(root, value):
    if not isinstance(value, str) or not value or "\\" in value or "\x00" in value:
        raise ArtifactError("invalid task path")
    p = PurePosixPath(value)
    if p.is_absolute() or any(x in ("", ".", "..") for x in value.split("/")):
        raise ArtifactError("task paths must be normalized relative files")
    lower_parts = [x.lower() for x in p.parts]
    if any(x in _FORBIDDEN_PARTS or x == ".env" or x.startswith(".env.") for x in lower_parts):
        raise ArtifactError("sensitive, evidence, or runtime path cannot be checkpointed")
    if lower_parts[-1] in _SECRET_NAMES:
        raise ArtifactError("credential/session path cannot be checkpointed")
    if lower_parts[:2] in (["tooling", "multica-pipeline"], ["tooling", "pipeline"]):
        raise ArtifactError("task delivery cannot modify its own controller")
    cursor = root
    for part in p.parts:
        cursor = cursor / part
        if cursor.is_symlink():
            raise ArtifactError("symlink task paths are forbidden")
    if cursor.exists() and not cursor.is_file():
        raise ArtifactError("declare individual files, not directories")
    if not cursor.resolve().is_relative_to(root):
        raise ArtifactError("task path escapes worktree")
    return p.as_posix()


def _names(raw):
    return [x.decode("utf-8") for x in raw.split(b"\x00") if x]


def checkpoint(workdir, issue, generation, allowed_paths, *, repository=None):
    """Commit only declared task files on an owned worktree, never the original.

    Uses a private temporary index and commit-tree, so hooks cannot smuggle
    unrelated staged files into the checkpoint. The actual index is updated
    only for declared paths; all other staged/unstaged files remain untouched.
    """
    root = _root(workdir, repository)
    if not isinstance(issue, str) or not _ISSUE.fullmatch(issue):
        raise ArtifactError("invalid issue key")
    if type(generation) is not int or generation < 1:
        raise ArtifactError("generation must be positive")
    if not isinstance(allowed_paths, (list, tuple)) or not allowed_paths:
        raise ArtifactError("nonempty declared task paths required")
    paths = sorted({_path(root, value) for value in allowed_paths})
    if _git(root, "ls-files", "-u", "-z").stdout:
        raise ArtifactError("unresolved merge cannot be delivered")
    base = _commit(root, _text(root, "rev-parse", "HEAD"))
    with tempfile.TemporaryDirectory(prefix="pitchroom-index-") as temp:
        index_env = {"GIT_INDEX_FILE": str(Path(temp) / "index")}
        _git(root, "read-tree", base, env=index_env)
        _git(root, "add", "--", *paths, env=index_env)
        changed = _names(_git(root, "diff", "--cached", "--no-renames", "--name-only", "-z", base, env=index_env).stdout)
        if set(changed) - set(paths):
            raise ArtifactError("checkpoint contains undeclared paths")
        for path in changed:
            _path(root, path)
        for entry in _git(root, "ls-files", "--stage", "-z", "--", *changed, env=index_env).stdout.split(b"\x00") if changed else []:
            if entry:
                mode = entry.split(b" ", 1)[0]
                if mode not in (b"100644", b"100755"):
                    raise ArtifactError("only regular task files may be delivered")
        tree = _git(root, "write-tree", env=index_env).stdout.decode().strip()
        if changed:
            message = f"{issue}: delivery checkpoint generation {generation}\n".encode()
            commit = _git(root, "commit-tree", tree, "-p", base, input=message, env=index_env).stdout.decode().strip()
            _oid(commit)
            # Compare-and-swap the worktree's HEAD; never overwrite another writer.
            _git(root, "update-ref", "HEAD", commit, base)
            # Align only changed entries in the real index. No checkout/reset.
            entries = _git(root, "ls-tree", "-r", "-z", commit, "--", *changed).stdout
            by_path = {}
            for entry in entries.split(b"\x00"):
                if entry:
                    metadata, path = entry.split(b"\t", 1)
                    mode, kind, oid = metadata.split(b" ")
                    if kind != b"blob" or mode not in (b"100644", b"100755"):
                        raise ArtifactError("only regular task files may be delivered")
                    by_path[path.decode()] = mode + b" " + oid + b"\t" + path + b"\x00"
            index_info = b"".join(by_path.get(path, b"0 " + b"0" * len(base) + b"\t" + path.encode() + b"\x00") for path in changed)
            _git(root, "update-index", "-z", "--index-info", input=index_info)
        else:
            commit = base
    return {"issue": issue, "generation": generation, "commit": commit,
            "tree": tree, "base": base, "changed_paths": changed,
            "common_dir": common_dir(root)}


def materialize(repository, commit, destination):
    """Create a fresh detached child worktree at exactly the delivered commit."""
    repo = Path(repository).resolve(strict=True)
    commit = _commit(repo, commit)
    raw = Path(destination)
    if raw.name in ("", ".", "..") or ".." in raw.parts:
        raise ArtifactError("verification destination must be a normalized path")
    if os.path.lexists(raw):
        raise ArtifactError("verification destination already exists")
    if any(parent.is_symlink() for parent in raw.parents):
        raise ArtifactError("verification destination must not traverse symlinks")
    if not raw.parent.exists():
        raise ArtifactError("verification destination parent must exist")
    dest = raw.parent.resolve(strict=True) / raw.name
    if dest == repo or repo.is_relative_to(dest):
        raise ArtifactError("verification destination cannot contain source repository")
    _git(repo, "worktree", "add", "--detach", str(dest), commit)
    tree = _text(dest, "rev-parse", "HEAD^{tree}")
    verify_clean_tree(dest, tree)
    if common_dir(dest) != common_dir(repo):
        raise ArtifactError("verification checkout has wrong common repository")
    return {"workdir": str(dest), "commit": commit, "tree": tree,
            "common_dir": common_dir(repo)}


def verify_clean_tree(workdir, expected_tree):
    """Reject another commit tree or any tracked/unignored uncommitted change."""
    root = _root(workdir)
    _oid(expected_tree)
    if _text(root, "rev-parse", "HEAD^{tree}") != expected_tree:
        raise ArtifactError("verification tree differs from delivered tree")
    if _git(root, "status", "--porcelain=v1", "-z", "--untracked-files=all").stdout:
        raise ArtifactError("verification checkout is dirty")
    return True


def verify_squash_merge(repository, approved_head, merged_commit, integration_base):
    """Prove a single-parent integration has exactly the approved three-way tree."""
    repo = Path(repository).resolve(strict=True)
    head, merged = _commit(repo, approved_head), _commit(repo, merged_commit)
    captured_base = _commit(repo, integration_base)
    parents = _text(repo, "rev-list", "--parents", "-n", "1", merged).split()
    if len(parents) != 2:
        raise ArtifactError("Squash and merge requires one integration parent")
    if parents[1] != captured_base:
        raise ArtifactError("integration parent differs from the recorded pre-merge main")
    result = _git(repo, "merge-tree", "--write-tree", captured_base, head, check=False)
    if result.returncode:
        raise ArtifactError("approved source cannot merge cleanly; explicit integration review required")
    expected = result.stdout.decode().splitlines()[0]
    _oid(expected)
    actual = _text(repo, "rev-parse", merged + "^{tree}")
    if expected != actual:
        raise ArtifactError("squash result differs from the approved source integration")
    return {"method":"squash", "head":head, "commit":merged, "parent":parents[1], "tree":actual}


def has_ancestor(repository, commit, base):
    """Whether the accepted prerequisite commit is actually in the start base."""
    repo = Path(repository).resolve(strict=True)
    commit, base = _commit(repo, commit), _commit(repo, base)
    result = _git(repo, "merge-base", "--is-ancestor", commit, base, check=False)
    if result.returncode not in (0, 1):
        raise ArtifactError("cannot establish prerequisite lineage")
    return result.returncode == 0


def _dependency_roots(repository):
    for path in (repository / "node_modules", repository / "pitchroom-app"):
        if path.is_symlink():
            raise ArtifactError("installed dependency source traverses a symlink")
    roots = [repository / "node_modules", repository / "pitchroom-app" / "node_modules"]
    for kind in ("apps", "packages"):
        parent = repository / "pitchroom-app" / kind
        if parent.is_symlink():
            raise ArtifactError("workspace package directory is a symlink")
        if parent.is_dir():
            roots.extend(path / "node_modules" for path in sorted(parent.iterdir()) if path.is_dir() and not path.is_symlink())
    return [path for path in roots if path.is_dir() or path.is_symlink()]


_DEPENDENCY_POLICY = "installed-packages-v2-fresh-runtime-caches"
_RUNTIME_CACHES = {".vite", ".vitest-cache"}


def _ignored_install_entry(directory, name, install_roots):
    lower = name.lower()
    return lower == ".env" or lower.startswith(".env.") or (Path(directory) in install_roots and name in _RUNTIME_CACHES)


def _verify_runtime_cache_boundaries(roots):
    for install in roots:
        for name in _RUNTIME_CACHES:
            cache = install / name
            if not os.path.lexists(cache):
                continue
            if cache.is_symlink() or not cache.is_dir():
                raise ArtifactError("runtime cache must be a local directory")
            for directory, dirs, names in os.walk(cache, followlinks=False):
                for entry in dirs + names:
                    path = Path(directory) / entry
                    if path.is_symlink() or not (path.is_file() or path.is_dir()):
                        raise ArtifactError("runtime cache cannot contain links or special entries")


def _dependency_manifest(base, roots, *, projected_base=None):
    """Hash files and relative links without following installed symlinks."""
    digest = hashlib.sha256()
    files = links = size = 0
    for install in roots:
        if install.is_symlink():
            raise ArtifactError("installed node_modules root must not be a symlink")
        for directory, dirs, names in os.walk(install, followlinks=False):
            dirs[:] = sorted(x for x in dirs if not _ignored_install_entry(directory, x, set(roots)))
            names = sorted(x for x in names if not _ignored_install_entry(directory, x, set(roots)))
            for name in sorted(set(names + [x for x in dirs if (Path(directory) / x).is_symlink()])):
                path = Path(directory) / name
                relative = path.relative_to(base).as_posix()
                if path.is_symlink():
                    target = os.readlink(path)
                    if os.path.isabs(target):
                        raise ArtifactError("absolute dependency symlink is not portable")
                    projected = (projected_base or base) / relative
                    # Lexical containment before copy, then realpath containment after copy.
                    normalized = Path(os.path.normpath(str(projected.parent / target)))
                    if not normalized.is_relative_to(projected_base or base):
                        raise ArtifactError("dependency link escapes isolated checkout")
                    if projected_base is None and not projected.resolve().is_relative_to(base):
                        raise ArtifactError("dependency symlink resolves outside isolated checkout")
                    digest.update(b"L\x00" + relative.encode() + b"\x00" + target.encode() + b"\x00")
                    links += 1
                elif path.is_file():
                    h = hashlib.sha256()
                    with path.open("rb") as stream:
                        while chunk := stream.read(1024 * 1024):
                            h.update(chunk)
                    stat = path.stat()
                    digest.update(b"F\x00" + relative.encode() + b"\x00" + str(stat.st_mode & 0o777).encode() + b"\x00" + h.digest() + b"\x00")
                    files += 1
                    size += stat.st_size
                else:
                    raise ArtifactError("dependency tree contains a special filesystem entry")
    return {"sha256": digest.hexdigest(), "files": files, "symlinks": links, "bytes": size}


def prepare_dependencies(repository, checkout):
    """Copy existing install trees into an exact checkout; never install or link source.

    Workspace package links remain relative, hence resolve against the artifact's
    own source. Existing destination install trees are refused, rather than
    silently trusting an unrelated version. Partial failures are retained.
    Production environment files are never copied.
    """
    repo = Path(repository).resolve(strict=True)
    dest = _root(checkout)
    if dest == repo or common_dir(dest) != common_dir(repo):
        raise ArtifactError("dependency target must be an isolated checkout of the bound repository")
    roots = _dependency_roots(repo)
    if not roots:
        raise ArtifactError("no existing installed dependencies are available")
    for install in roots:
        cursor = install
        while cursor != repo:
            if cursor.is_symlink():
                raise ArtifactError("installed dependency source traverses a symlink")
            cursor = cursor.parent
    relative_roots = [path.relative_to(repo) for path in roots]
    for relative in relative_roots:
        target = dest / relative
        if os.path.lexists(target):
            raise ArtifactError("dependency destination already exists")
        cursor = dest
        for part in relative.parts[:-1]:
            cursor = cursor / part
            if cursor.is_symlink():
                raise ArtifactError("dependency destination traverses a symlink")
    before = _dependency_manifest(repo, roots, projected_base=dest)
    def ignore_env(directory, names):
        return [name for name in names if _ignored_install_entry(directory, name, set(roots))]
    for source, relative in zip(roots, relative_roots):
        shutil.copytree(source, dest / relative, symlinks=True, copy_function=shutil.copy2, ignore=ignore_env)
    copied_roots = [dest / relative for relative in relative_roots]
    copied = _dependency_manifest(dest, copied_roots)
    after = _dependency_manifest(repo, roots, projected_base=dest)
    if before != copied or before != after:
        raise ArtifactError("installed dependency tree changed or copy is not identical")
    return {**copied, "fingerprint_policy": _DEPENDENCY_POLICY, "roots": [path.as_posix() for path in relative_roots],
            "environment_files_copied": False, "installed": False, "hardlinked": False}


def verify_dependencies(checkout, expected):
    """Refuse ignored install mutation before or after executable checks."""
    dest = _root(checkout)
    if expected.get("fingerprint_policy") != _DEPENDENCY_POLICY:
        raise ArtifactError("dependency fingerprint policy requires a fresh generation; do not refresh old receipts")
    roots = _dependency_roots(dest)
    _verify_runtime_cache_boundaries(roots)
    actual = _dependency_manifest(dest, roots)
    if [p.relative_to(dest).as_posix() for p in roots] != expected["roots"] or any(actual[k] != expected[k] for k in ("sha256", "files", "symlinks", "bytes")):
        raise ArtifactError("installed dependency identity changed")
    return True


def checkpoint_runtime_metadata(workdir, issue, generation, *, repository):
    """Capture only Multica's managed AGENTS block on an isolated run branch."""
    root = _root(workdir, repository)
    path = root / "AGENTS.md"
    if not path.exists():
        return None
    before = _git(root, "show", "HEAD:AGENTS.md", check=False)
    if before.returncode:
        raise ArtifactError("runtime metadata has no tracked original")
    old, new = before.stdout.decode(), path.read_text()
    if old == new:
        return None
    start = "<!-- BEGIN MULTICA-RUNTIME (auto-managed; do not edit) -->"
    end = "<!-- END MULTICA-RUNTIME -->"
    def original(text):
        if start not in text:
            if end in text:
                raise ArtifactError("malformed runtime metadata")
            return text.rstrip()
        if text.count(start) != 1 or text.count(end) != 1:
            raise ArtifactError("malformed runtime metadata")
        prefix, block = text.split(start)
        _, suffix = block.split(end)
        if suffix.strip():
            raise ArtifactError("unexpected content after managed runtime metadata")
        return prefix.rstrip()
    if start not in new or original(old) != original(new):
        raise ArtifactError("AGENTS changes extend beyond managed runtime metadata")
    return checkpoint(root, issue, generation, ["AGENTS.md"], repository=repository)
