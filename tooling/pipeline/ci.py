#!/usr/bin/env python3
"""Run isolated CI commands; expose stage/exit only, keep raw output local."""
import argparse
import os
from pathlib import Path
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[2]
APP = ROOT / 'pitchroom-app'
STAGES = {
    'install': ['pnpm', 'install', '--frozen-lockfile'],
    'typecheck': ['pnpm', 'typecheck'],
    'unit': ['pnpm', 'test'],
    'offline-eval': ['pnpm', 'eval:offline'],
    'database-guard': ['pnpm', 'test:server:guard'],
    'build': ['pnpm', 'build'],
    'database': ['pnpm', 'test:server'],
    'browser': ['pnpm', '--filter', '@pitchroom/web', 'exec', 'playwright', 'test', '--config', 'playwright-ci.config.mjs'],
}


def environment(stage, source):
    # Never inherit provider credentials, GitHub token or a personal DB target.
    names = ('PATH', 'HOME', 'TMPDIR', 'RUNNER_TEMP', 'PNPM_HOME', 'NODE_EXTRA_CA_CERTS')
    env = {k: source[k] for k in names if k in source}
    env.update(CI='true', NEXT_TELEMETRY_DISABLED='1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1', PITCHROOM_RUNTIME='fixture')
    if stage == 'database':
        env['DATABASE_URL'] = 'postgres://clarify_qa:clarify_qa@127.0.0.1:55437/clarify_qa'
    return env


def run_stage(stage):
    directory = Path(tempfile.mkdtemp(prefix='pitchroom-ci-', dir=os.environ.get('RUNNER_TEMP')))
    log = directory / (stage + '.log')
    try:
        with log.open('wb') as stream:
            process = subprocess.run(STAGES[stage], cwd=APP, env=environment(stage, os.environ), stdout=stream, stderr=subprocess.STDOUT, timeout=900)
        code = process.returncode
    except (OSError, subprocess.TimeoutExpired):
        code = 124
    print(f'{stage}: {"PASS" if code == 0 else "FAIL"}; exit={code}; raw output retained only in runner temporary directory.')
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as stream:
            stream.write(f'| {stage} | {"PASS" if code == 0 else "FAIL"} | {code} |\n')
    return code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=STAGES)
    raise SystemExit(run_stage(parser.parse_args().stage))
