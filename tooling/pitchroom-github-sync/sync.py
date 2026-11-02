#!/usr/bin/env python3
"""Export a reviewed source tree onto the separate private GitHub history."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[2]
REPO = "shaunlidev/Pitchy"
URL = f"https://github.com/{REPO}.git"
MIRROR = ROOT / ".pitchroom-github"
HELPER = "tooling/pitchroom-github-sync"
BLOCKED = re.compile(r"(?i)(participant|real-material|pitchroom-real|credential|\.env(?!\.example$)|\.(?:db|sqlite|dump|pem|key|log)(?:$|[-.])|tsbuildinfo|node_modules|\.next|\.artifacts|\.vercel|pgdata)")
SECRETS = [
    re.compile(r"\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16})"),
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    re.compile(r"(?:postgres(?:ql)?|mongodb(?:\+srv)?)://[^\s\"'<>]+"),
    re.compile(r"(?i)(?:api[_-]?key|secret|password|access[_-]?token|authorization)[\"']?\s*[=:]\s*[\"']([^\"'\n]{8,})[\"']"),
]


def run(*args, cwd=ROOT):
    return subprocess.check_output(args, cwd=cwd, text=True).strip()


def git(*args):
    return run("git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", *args, cwd=MIRROR)


def check(path, data):
    if BLOCKED.search(path):
        raise ValueError(f"Excluded filename: {path}")
    text = data.decode("utf-8")
    if "\0" in text or len(data) > 2_000_000:
        raise ValueError(f"Binary or oversized file: {path}")
    is_test = bool(re.search(r"(?:test|spec|testkit)\.[cm]?[jt]sx?$|(?:^|/)test_[^/]+\.py$", path))
    for pattern in SECRETS:
        for match in pattern.finditer(text):
            value = match.group(0)
            if value.startswith(("postgres://", "postgresql://", "mongodb")):
                from urllib.parse import urlsplit
                parsed = urlsplit(value)
                host = parsed.hostname
                placeholder = parsed.password is None or parsed.password in {"pitchroom", "clarify_qa", "postgres", "test", "qa", "x"} or (is_test and parsed.password == "synthetic") or bool(re.fullmatch(r"\$\{[A-Za-z_][A-Za-z0-9_]*\}", parsed.password or ""))
                if placeholder and host in {"localhost", "127.0.0.1", "db", "x", "test", "synthetic", "local", "invalid"}:
                    continue
                if is_test and host and host.endswith((".example", ".invalid")) and (placeholder or parsed.password == "example"):
                    continue
            elif pattern is SECRETS[-1]:
                dummy = match.group(1)
                if is_test and (dummy.startswith(("test-", "offline-", "never-write-", "Bearer actual-key-")) or dummy in {"project-secret", "secret-password", "provider-auth-secret", "synthetic-secret-must-not-be-printed", "[REDACTED]"}):
                    continue
                if dummy == "pitchroom" and path.endswith("compose.yaml"):
                    continue
            line = text[:match.start()].count("\n") + 1
            raise ValueError(f"Possible credential at {path}:{line}; value withheld")


def candidate():
    allowed = set(json.loads((ROOT / HELPER / "allowed-files.json").read_text()))
    # Only source files in known code directories are automatically added.
    for base in ("pitchroom-app/apps", "pitchroom-app/packages", "pitchroom-app/scripts"):
        for folder, dirs, names in os.walk(ROOT / base, followlinks=False):
            dirs[:] = [d for d in dirs if not d.startswith(".") and d not in {"node_modules", "dist", "build", "test-results", "playwright-report", "docs", "config", "migrations"} and not (Path(folder) / d).is_symlink()]
            for name in names:
                p = Path(folder) / name
                if p.suffix in {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".css"} and not BLOCKED.search(p.relative_to(ROOT).as_posix()):
                    allowed.add(p.relative_to(ROOT).as_posix())
    migrations = ROOT / "pitchroom-app/packages/persistence/migrations"
    if migrations.exists():
        for p in migrations.glob("*.sql"):
            if re.fullmatch(r"\d{4}_[a-zA-Z0-9_]+\.sql", p.name):
                allowed.add(p.relative_to(ROOT).as_posix())
        for p in (migrations / "meta").glob("*_snapshot.json"):
            if re.fullmatch(r"\d{4}_snapshot\.json", p.name):
                allowed.add(p.relative_to(ROOT).as_posix())
    allowed.update(f"{HELPER}/{name}" for name in ("sync.py", "allowed-files.json", "README.md", "test_sync.py"))
    result = {}
    for name in sorted(allowed):
        if not name.startswith(("pitchroom-app/", HELPER + "/")) or ".." in Path(name).parts:
            raise ValueError(f"Invalid allowlist path: {name}")
        path = ROOT / name
        if any((ROOT / Path(*Path(name).parts[:i])).is_symlink() for i in range(1, len(Path(name).parts) + 1)):
            raise ValueError(f"Symlink forbidden: {name}")
        if not path.exists():
            continue  # Propagate intentional source deletion.
        if name == "pitchroom-app/apps/web/next-env.d.ts":
            data = b'/// <reference types="next" />\n/// <reference types="next/image-types/global" />\nimport "./.next/dev/types/routes.d.ts";\nimport "./.next/dev/types/root-params.d.ts";\n\n// NOTE: This file should not be edited\n// see https://nextjs.org/docs/app/api-reference/config/typescript for more information.\n'
        else:
            data = path.read_bytes()
        check(name, data)
        result[name] = data
    result[".gitignore"] = b"**/node_modules/\n**/.next/\n**/.next-*/\n**/.artifacts/\n**/.env\n**/.env.*\n!**/.env.example\n**/.vercel/\n**/.pitchroom/\n**/.gstack/\n**/test-results/\n**/playwright-report/\n**/*.tsbuildinfo\n**/*.log\n**/*.db\n**/*.db-*\n**/*.sqlite*\n**/*.dump\n**/*.pem\n**/*.key\n**/pgdata/\n**/.DS_Store\n.pitchroom-github/\n.pitchroom-github.lock\n"
    return result


def audit_repo():
    for path in git("ls-files", "-z").split("\0"):
        if not path:
            continue
        if not (path.startswith("pitchroom-app/") or path.startswith(HELPER + "/") or path in {"README.md", ".gitignore"}):
            raise ValueError(f"Unexpected tracked path: {path}")
        if git("ls-files", "-s", "--", path).startswith("120000"):
            raise ValueError(f"Symlink forbidden: {path}")
        check(path, (MIRROR / path).read_bytes())


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--push", action="store_true", help="Commit the reviewed snapshot and push main")
    parser.add_argument("-m", "--message")
    parser.add_argument("--audit", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.push:
        raise ValueError("Direct snapshot pushes are retired. Use a task worktree, guarded git push, and a Draft PR.")
    if args.audit:
        audit_repo()
        return
    if args.push and not args.message:
        parser.error("--push requires -m with a meaningful commit message")
    with open(ROOT / ".pitchroom-github.lock", "a") as lock:
        try:
            fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise ValueError("Another GitHub sync is running")
        synchronize(args)


def synchronize(args):
    contents = candidate()  # Scan before any network or mirror mutation.
    if not MIRROR.exists():
        run("git", "-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential", "clone", URL, str(MIRROR))
    if git("remote", "get-url", "origin") != URL or git("branch", "--show-current") != "main":
        raise ValueError("Unexpected mirror origin or branch")
    if git("status", "--porcelain"):
        raise ValueError("Sync checkout is dirty; inspect .pitchroom-github before continuing")
    audit_repo()
    metadata = json.loads(run("gh", "repo", "view", REPO, "--json", "visibility,nameWithOwner"))
    if metadata != {"nameWithOwner": REPO, "visibility": "PRIVATE"}:
        raise ValueError("Target must be the expected PRIVATE repository")
    git("fetch", "origin", "main")
    # Keep any local committed-but-unpushed changes for a safe retry.
    if git("merge-base", "HEAD", "origin/main") != git("rev-parse", "origin/main"):
        git("merge", "--ff-only", "origin/main")
    if args.push:
        git("config", "user.name", "shaunlidev")
        git("config", "user.email", "58508892+shaunlidev@users.noreply.github.com")
    tracked = set(git("ls-files", "-z").split("\0")) - {""}
    changes = []
    for name in sorted(set(contents) | {p for p in tracked if p.startswith(("pitchroom-app/", HELPER + "/"))}):
        dest = MIRROR / name
        if name not in contents:
            changes.append(("D", name))
        elif not dest.exists() or dest.read_bytes() != contents[name]:
            changes.append(("M" if name in tracked else "A", name))
    for kind, name in changes:
        print(f"{kind} {name}")
    print(f"Scanned {len(contents)} files; {len(changes)} changes. Private target: {REPO}")
    if not args.push:
        print("Preview only. Use --push -m 'description' to commit and push.")
        return
    for kind, name in changes:
        dest = MIRROR / name
        if kind == "D":
            dest.unlink()
        else:
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(contents[name])
    git("add", "--", ".gitignore", "pitchroom-app", HELPER)
    audit_repo()
    if git("diff", "--cached", "--name-only"):
        git("commit", "-m", args.message)
    git("push", "origin", "HEAD:main")  # Never force; concurrent remote changes reject safely.
    git("fetch", "origin", "main")
    if git("rev-parse", "HEAD") != git("rev-parse", "origin/main"):
        raise ValueError("Remote verification failed")
    print("Verified main:", git("rev-parse", "--short", "HEAD"))


if __name__ == "__main__":
    try:
        main()
    except (ValueError, UnicodeError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
