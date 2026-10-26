#!/usr/bin/env python3
"""Check every outgoing source commit and tooling behavior without raw CI logs."""
import os
from pathlib import Path
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'tooling/pitchroom-github-sync'))
from delivery import audit


def main():
    base = os.environ.get('BASE_SHA', '')
    head = subprocess.check_output(['git', 'rev-parse', 'HEAD'], cwd=ROOT, text=True).strip()
    commits = [head]
    if base and set(base) != {'0'}:
        # Unknown base is a failure, never fall back to a clean-head-only scan.
        commits = subprocess.check_output(['git', 'rev-list', f'{base}..{head}'], cwd=ROOT, text=True).splitlines() or [head]
    with tempfile.TemporaryFile() as log:
        for directory in ('tooling/pitchroom-github-sync', 'tooling/pipeline'):
            result = subprocess.run([sys.executable, '-B', '-m', 'unittest', 'discover', '-s', directory, '-p', 'test_*.py'], cwd=ROOT, stdout=log, stderr=subprocess.STDOUT, timeout=120)
            if result.returncode:
                print(f'Tooling behavior FAIL: {directory}; raw output is not uploaded.')
                return 1
        try:
            count = audit(commits)
        except Exception:
            print('Committed source boundary FAIL; inspect locally. Raw content is not uploaded.')
            return 1
    print(f'Source boundary PASS: {len(commits)} commits, {count} file versions; tooling behavior PASS.')
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
