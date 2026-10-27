#!/usr/bin/env python3
"""Serial Pitchroom PR push guard; never merges or pushes."""
import argparse
import hashlib
import json
import re
import shlex
import subprocess
import sys
from pathlib import Path
from sync import check

URL = 'https://github.com/shaunlidev/pitchroom.git'
TASK = re.compile(r'refs/heads/codex/pit-\d+-[a-z0-9-]+$')
ZERO = re.compile(r'0+$')
RUNTIME_PARTS = {'.pitchroom', '.gstack', '.multica', '.multica-round', '.pipeline-local', '.pipeline-artifact', '.artifacts', '.local', '.vercel', '.trash', 'archive', 'test-results', 'playwright-report', 'node_modules', 'dist', 'build', 'screenshots', 'recordings', 'artifacts', 'evidence', 'logs', 'uploads', 'storage', 'sessions', 'cache', 'tmp', 'temp', 'coverage'}


# PIT-58: only the five reviewed product-contract sources from PIT-50 1dba35e.
# New content requires explicit review and a new receipt; no docs/config wildcard.
REVIEWED_EVAL_SOURCES = {
    'pitchroom-app/docs/evals/task-acceptance-protocol.md': '5867f4b818c330fa4fbc97729a04fe4a0b2c56f8174a5e8b31789d21a139d774',
    'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/case.json': '15a6342a74087a57014392b2e368d2614bd774a27705b7716ceec05e6645a5ca',
    'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/materials.json': '3af4723a9aaf0c82ff57aa8e20cebfc1d682d0a87718c0b3d3cceb16b5206f21',
    'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/oracle.json': 'a0753a978dee2bd8cb4406f2351c262ab7b8360ce9495197f428ec2b22654deb',
    'pitchroom-app/packages/evals/config/task-acceptance/pitchroom-r1/task.md': '24940981939f3c5cc25a724ad34cb75c88a1da4c511d16d9e4a92226a9b0b42b',
}


def git(*args):
    return subprocess.check_output(['git', *args], text=True).strip()


def safe_destination(local_sha, remote_ref):
    if ZERO.fullmatch(local_sha) or not TASK.fullmatch(remote_ref):
        raise ValueError('Only non-deletion codex/pit-N-description branch updates are allowed; main is protected locally')


def allowed_path(path, reviewed=()):
    # Explicit infrastructure files only; all other hidden/runtime paths stay refused.
    infrastructure = {
        '.github/workflows/pr-ci.yml',
        'docs/development/PIPELINE.md',
        'docs/development/migration-plan.json',
        'tooling/pipeline/policy.json',
        'tooling/pipeline/status.py',
        'tooling/pipeline/ci.py',
        'tooling/pipeline/check-source.py',
        'tooling/pipeline/test_pipeline.py',
        'tooling/pipeline/controller.py',
        'tooling/pipeline/acceptance.py',
        'tooling/pipeline/artifacts.py',
        'tooling/pipeline/serial.py',
        'tooling/pipeline/github_sync.py',
        'tooling/pipeline/runtime.json',
        'tooling/pipeline/ROLE_GUIDE.md',
        'tooling/pipeline/test_controller.py',
        'tooling/pipeline/test_artifacts.py',
        'tooling/pipeline/test_acceptance.py',
        'tooling/pipeline/test_resolutions.py',
        'tooling/pipeline/test_polling.py',
        'tooling/pipeline-status/snapshot.py',
        'tooling/pipeline-status/test_snapshot.py',
        'tooling/pipeline-status/view.py',
        'tooling/pipeline-status/test_view.py',

    }
    if path in infrastructure:
        return True
    parts = [part.lower() for part in Path(path).parts]
    if any(part in RUNTIME_PARTS or part.startswith(".next") for part in parts) or any(part.startswith(".") for part in parts[:-1]):
        return False
    if path in {'.gitignore', 'README.md', 'AGENTS.md', 'SOURCE_OF_TRUTH.md', 'docs/development/git-migration.json'}:
        return True
    if path.startswith('pitchroom-v6/'):
        return path.removeprefix('pitchroom-v6/') in {'README.md', 'PRD.md', 'DESIGN.md', 'HARNESS.md', 'manifest.json'}
    if path.startswith('tooling/pitchroom-github-sync/'):
        return path.removeprefix('tooling/pitchroom-github-sync/') in {'sync.py', 'test_sync.py', 'allowed-files.json', 'README.md', 'delivery.py', 'test_delivery.py'}
    if not path.startswith('pitchroom-app/'):
        return False
    if path in REVIEWED_EVAL_SOURCES:
        return True
    relative = path.removeprefix('pitchroom-app/')
    if relative.startswith('docs/'):
        return False
    if relative.startswith(('apps/', 'packages/', 'scripts/')):
        if path in reviewed:
            return True
        if re.fullmatch(r"pitchroom-app/packages/persistence/migrations/(?:[0-9]{4}_[a-zA-Z0-9_]+\.sql|meta/[0-9]{4}_snapshot\.json)", path):
            return True
        return Path(path).suffix in {'.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.css'} and '/config/' not in path
    return relative in {'.env.example', '.gitignore', 'README.md', 'RUNBOOK.md', 'SECURITY.md', 'DEPLOYMENT_CHECKLIST.md', 'package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'compose.yaml', 'tsconfig.base.json'}


def audit(commits):
    seen = set()
    for commit in commits:
        policy = json.loads(git("show", commit + ":tooling/pitchroom-github-sync/allowed-files.json"))
        migration = subprocess.run(["git", "show", commit + ":docs/development/git-migration.json"], capture_output=True, text=True)
        reviewed = set(policy)
        if migration.returncode == 0:
            reviewed.update(json.loads(migration.stdout)["files"])
        for row in subprocess.check_output(['git', 'ls-tree', '-r', '-z', commit]).split(b'\0'):
            if not row:
                continue
            metadata, name = row.split(b'\t', 1)
            mode, kind, oid = metadata.decode().split()
            path = name.decode()
            if mode not in {'100644', '100755'} or kind != 'blob' or not allowed_path(path, reviewed):
                raise ValueError(f'Unsafe committed path or mode: {path}')
            identity = (path, oid)
            if identity in seen:
                continue
            seen.add(identity)
            if int(git('cat-file', '-s', oid)) > 2_000_000:
                raise ValueError(f'Oversized committed file: {path}')
            data = subprocess.check_output(['git', 'cat-file', 'blob', oid])
            expected = REVIEWED_EVAL_SOURCES.get(path)
            if expected is not None and hashlib.sha256(data).hexdigest() != expected:
                raise ValueError(f'Reviewed source content changed: {path}; explicit review required')
            check(path, data)
    return len(seen)


def hook(remote_name, remote_url, lines):
    if remote_name != 'origin' or remote_url != URL:
        raise ValueError('Unexpected push remote')
    outgoing = set()
    for line in lines:
        if not line.strip():
            continue
        local_ref, local_sha, remote_ref, remote_sha = line.split()
        safe_destination(local_sha, remote_ref)
        if not ZERO.fullmatch(remote_sha) and subprocess.run(['git', 'merge-base', '--is-ancestor', remote_sha, local_sha], capture_output=True).returncode:
            raise ValueError('Non-fast-forward or unknown remote history; fetch and reconcile, never force')
        outgoing.update(git('rev-list', local_sha, '--not', '--remotes=origin').splitlines())
        outgoing.add(local_sha)
    count = audit(sorted(outgoing))
    metadata = json.loads(subprocess.check_output(['gh', 'repo', 'view', 'shaunlidev/pitchroom', '--json', 'visibility,nameWithOwner'], text=True))
    if metadata != {'visibility': 'PRIVATE', 'nameWithOwner': 'shaunlidev/pitchroom'}:
        raise ValueError('Destination must be the expected PRIVATE repository')
    print(f'Push guard passed: {len(outgoing)} commits, {count} file versions', file=sys.stderr)


def install():
    hooks = Path(git('rev-parse', '--path-format=absolute', '--git-common-dir')) / 'pitchroom-hooks'
    old = subprocess.run(['git', 'config', '--get', 'core.hooksPath'], capture_output=True, text=True)
    if old.returncode == 0 and Path(old.stdout.strip()) != hooks:
        raise ValueError('Existing hooksPath must be preserved and reconciled')
    hooks.mkdir(exist_ok=True)
    target = hooks / 'pre-push'
    content = '#!/bin/sh\nexec ' + shlex.quote(sys.executable) + ' ' + shlex.quote(str(Path(__file__).resolve())) + ' hook "$@"\n'
    if target.exists() and target.read_text() != content:
        raise ValueError('Existing hook differs; inspect before replacing it')
    target.write_text(content)
    target.chmod(0o755)
    git('config', '--local', 'core.hooksPath', str(hooks))
    print('Installed shared pre-push hook. Retain this tool checkout until reinstalled from a retained checkout.')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    sub.add_parser('install-hook')
    a = sub.add_parser('audit')
    a.add_argument('revision', nargs='?', default='HEAD')
    h = sub.add_parser('hook')
    h.add_argument('remote_name')
    h.add_argument('remote_url')
    args = parser.parse_args()
    if args.command == 'install-hook':
        install()
    elif args.command == 'audit':
        print('Scanned file versions:', audit([git('rev-parse', '--verify', args.revision + '^{commit}')]))
    else:
        hook(args.remote_name, args.remote_url, sys.stdin)


if __name__ == '__main__':
    try:
        main()
    except (ValueError, UnicodeError, subprocess.CalledProcessError) as exc:
        sys.exit(str(exc))
