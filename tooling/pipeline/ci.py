#!/usr/bin/env python3
"""Run isolated CI commands; expose bounded metadata, keep raw output local."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time

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
REPORT_LIMIT = 4_000_000
SUMMARY_LIMIT = 16_384
FAILURE_LIMIT = 10


def unit_reports(directory):
    """One fresh relative report per workspace; pnpm keeps its original test graph."""
    relative = Path('node_modules/.cache/pitchroom-ci') / (directory.name + '.json')
    workspaces = []
    for package in sorted([*APP.glob('apps/*/package.json'), *APP.glob('packages/*/package.json')]):
        script = json.loads(package.read_text()).get('scripts', {}).get('test')
        if script:
            if not isinstance(script, str) or not script.startswith('vitest run'):
                raise ValueError('unsupported_reporter')
            workspaces.append((package.parent, package.parent / relative))
    if not workspaces or len(workspaces) > 64:
        raise ValueError('workspace_inventory')
    for workspace, report in workspaces:
        assert_report_path(workspace, report)
        if report.exists():
            raise ValueError('report_already_exists')
    return ['pnpm', '-r', '--if-present', 'run', 'test', '--reporter=json', f'--outputFile={relative.as_posix()}'], workspaces


def offline_reports(directory):
    """Append JSON to the existing offline script without replacing its reporters."""
    workspace = APP / 'packages/evals'
    root = json.loads((APP / 'package.json').read_text())
    package = json.loads((workspace / 'package.json').read_text())
    if (root.get('scripts', {}).get('eval:offline') != 'pnpm --filter @pitchroom/evals eval:offline'
            or package.get('name') != '@pitchroom/evals'
            or package.get('scripts', {}).get('eval:offline') != 'vitest run --no-file-parallelism --reporter=verbose'):
        raise ValueError('unsupported_offline_script')
    relative = Path('node_modules/.cache/pitchroom-ci') / (directory.name + '.json')
    report = workspace / relative
    assert_report_path(workspace, report)
    if report.exists():
        raise ValueError('report_already_exists')
    return ['pnpm', '--filter', '@pitchroom/evals', 'run', 'eval:offline', '--reporter=json',
            f'--outputFile.json={relative.as_posix()}'], [(workspace, report)]


def offline_progress(event, started):
    # This is wrapper liveness, never test progress or an execution deadline.
    if event not in ('start', 'alive', 'end'):
        raise ValueError('unknown_progress_event')
    try:
        print('offline-liveness: ' + json.dumps({'event': event,
              'elapsed_seconds': max(0, int(time.monotonic() - started))}), flush=True)
    except OSError:
        pass  # A diagnostic sink failure must not replace the command result.


def offline_heartbeat(stop, started):
    for _ in range(30):
        remaining = 900 - (time.monotonic() - started)
        if remaining <= 0 or stop.wait(min(30, remaining)):
            return
        if time.monotonic() - started >= 900 or stop.is_set():
            return
        offline_progress('alive', started)


def assert_report_path(workspace, report):
    current = report
    while current != workspace:
        if current.is_symlink():
            raise ValueError('report_symlink')
        if workspace not in current.parents:
            raise ValueError('report_outside_workspace')
        current = current.parent


def diagnostic_context(env):
    result = {'node': None, 'pnpm': None, 'platform': None, 'arch': None, 'head': None}
    commands = {
        'node': ['node', '--version'], 'pnpm': ['pnpm', '--version'],
        'head': ['git', 'rev-parse', 'HEAD'],
        'platform': ['node', '-p', 'process.platform'], 'arch': ['node', '-p', 'process.arch'],
    }
    for name, argv in commands.items():
        try:
            value = subprocess.run(argv, cwd=APP, env=env, capture_output=True, text=True, timeout=5)
            text = value.stdout.strip()
            patterns = {'node': r'v\d+\.\d+\.\d+', 'pnpm': r'\d+\.\d+\.\d+', 'head': r'[a-f0-9]{40}', 'platform': r'(?:linux|darwin|win32)', 'arch': r'(?:x64|arm64|ia32|arm|ppc64|s390x)'}
            if value.returncode == 0 and re.fullmatch(patterns[name], text):
                result[name] = text
        except (OSError, subprocess.TimeoutExpired):
            pass
    return result


def safe_name(title):
    return isinstance(title, str) and 0 < len(title) <= 240 and not re.search(
        r'''(?:[\x00-\x1f]|://|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|-----BEGIN|(?i:bearer\s|(?:api[_-]?key|secret|password|access[_-]?token|authorization)["']?\s*[=:]))''', title)


def static_test_metadata(source, suffix):
    """Recognize only an unambiguous subset; never interpret comments/templates/JSX."""
    titles = {}
    ambiguous = suffix in ('.tsx', '.jsx') or '/*' in source or '`' in source or re.search(r'\\(?:\r\n|\r|\n)', source)
    if not ambiguous:
        for match in re.finditer(r'''^[ \t]*(?:it|test)[ \t]*\([ \t]*(["'])([^\\\r\n]*?)\1[ \t]*,''', source, re.MULTILINE):
            if safe_name(match.group(2)):
                titles.setdefault(match.group(2), []).append(source[:match.start()].count('\n') + 1)
    return {'line_count': source.count('\n') + 1, 'titles': titles}


def tracked_tests(env, head):
    if not isinstance(head, str) or not re.fullmatch(r'[a-f0-9]{40}', head):
        raise ValueError('unknown_source_head')
    result = subprocess.run(['git', 'ls-tree', '-r', '-z', '--name-only', head, '--', 'pitchroom-app'], cwd=ROOT, env=env, capture_output=True, timeout=5)
    if result.returncode:
        raise ValueError('source_inventory')
    catalogue = {}
    for name in result.stdout.split(b'\0'):
        if re.search(rb'\.(?:test|spec)\.[cm]?[jt]sx?$', name):
            relative = name.decode()
            blob = subprocess.run(['git', 'show', f'{head}:{relative}'], cwd=ROOT, env=env, capture_output=True, timeout=5)
            if blob.returncode or len(blob.stdout) > REPORT_LIMIT:
                raise ValueError('source_snapshot_unavailable')
            catalogue[relative] = static_test_metadata(blob.stdout.decode(), Path(relative).suffix)
    return catalogue


def failure_record(file, assertion, tracked):
    path = Path(os.path.normpath(file))
    relative = path.relative_to(ROOT).as_posix()
    if relative not in tracked:
        raise ValueError('unknown_test_source')
    metadata = tracked[relative]
    title = assertion.get('title', '')
    if not isinstance(title, str):
        raise ValueError('invalid_title')
    declarations = metadata['titles']
    safe_title = title if title in declarations and safe_name(title) else None
    messages = assertion.get('failureMessages', [])
    if not isinstance(messages, list) or any(not isinstance(item, str) for item in messages):
        raise ValueError('invalid_failure_messages')
    raw = '\n'.join(messages)
    full_name = assertion.get('fullName', title)
    if not isinstance(full_name, str):
        raise ValueError('invalid_case_identity')
    category = 'test_timeout' if 'Test timed out' in raw else 'assertion' if 'AssertionError' in raw else 'test_error'
    location = None
    for match in re.finditer(re.escape(str(path)) + r':([0-9]+):([0-9]+)', raw):
        line, column = int(match.group(1)), int(match.group(2))
        if 0 < line <= metadata['line_count'] and 0 < column <= 10000:
            location = {'line': line, 'column': column}
            break
    return {
        'file': relative, 'test': safe_title,
        'case_id': hashlib.sha256((relative + '\0' + full_name).encode()).hexdigest(),
        'declaration_line': declarations[title][0] if safe_title and len(declarations[title]) == 1 else None,
        'category': category, 'failure_location': location, 'failure_hash': hashlib.sha256(raw.encode()).hexdigest(),
    }


def summarize_unit(workspaces, tracked, code, context):
    summary = {'context': context, 'exit': code, 'status': 'complete', 'workspaces': [], 'failures': [], 'omitted_failures': 0}
    for workspace, report in workspaces:
        item = {'workspace': workspace.relative_to(APP).as_posix(), 'status': 'unavailable'}
        try:
            assert_report_path(workspace, report)
            if not report.is_file() or report.stat().st_size > REPORT_LIMIT:
                raise ValueError('missing_or_oversized_report')
            data = json.loads(report.read_text())
            counts = {key: data[key] for key in ('numTotalTests', 'numPassedTests', 'numFailedTests', 'numPendingTests', 'numTodoTests')}
            if any(type(value) is not int or value < 0 for value in counts.values()):
                raise ValueError('invalid_counts')
            if counts['numPassedTests'] + counts['numFailedTests'] > counts['numTotalTests']:
                raise ValueError('invalid_counts')
            item.update(status='reported', counts=counts)
            for file in data['testResults']:
                failures = [assertion for assertion in file['assertionResults'] if assertion.get('status') == 'failed']
                if file.get('status') == 'failed' and not failures:
                    failures = [{'title': '', 'failureMessages': [file.get('message', '')]}]
                for assertion in failures:
                    record = failure_record(file['name'], assertion, tracked)
                    if len(summary['failures']) < FAILURE_LIMIT:
                        summary['failures'].append(record)
                    else:
                        summary['omitted_failures'] += 1
        except (OSError, ValueError, KeyError, TypeError, AttributeError, RuntimeError):
            item['status'] = 'diagnostics_unavailable'
            item.pop('counts', None)
            summary['status'] = 'partial'
        summary['workspaces'].append(item)
    if code and not summary['failures']:
        summary['status'] = 'unattributed_nonzero_exit'
    return summary


def print_unit_summary(summary, stage='unit'):
    prefix = {'unit': 'unit-diagnostics: ', 'offline-eval': 'offline-diagnostics: '}[stage]
    while True:
        encoded = json.dumps(summary, ensure_ascii=True, separators=(',', ':'))
        if len(encoded.encode()) <= SUMMARY_LIMIT:
            print(prefix + encoded, flush=True)
            return
        if summary['failures']:
            summary['failures'].pop()
            summary['omitted_failures'] += 1
        else:
            print(prefix + '{"status":"diagnostics_unavailable","reason":"summary_limit"}', flush=True)
            return


def environment(stage, source):
    # Never inherit provider credentials, GitHub token or a personal DB target.
    names = ('PATH', 'HOME', 'TMPDIR', 'RUNNER_TEMP', 'PNPM_HOME', 'NODE_EXTRA_CA_CERTS')
    env = {k: source[k] for k in names if k in source}
    env.update(CI='true', NEXT_TELEMETRY_DISABLED='1', PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD='1', PITCHROOM_RUNTIME='fixture')
    if stage == 'database':
        env['DATABASE_URL'] = 'postgres://clarify_qa:clarify_qa@127.0.0.1:55437/clarify_qa'
    return env


def run_stage(stage):
    if stage != 'offline-eval':
        return execute_stage(stage)
    started = time.monotonic()
    stop = threading.Event()
    heartbeat = threading.Thread(target=offline_heartbeat, args=(stop, started), daemon=True)
    offline_progress('start', started)
    try:
        try:
            heartbeat.start()
        except RuntimeError:
            pass  # Optional liveness must not prevent the original command.
        return execute_stage(stage)
    finally:
        stop.set()
        if heartbeat.ident is not None:
            heartbeat.join(timeout=1)
        offline_progress('end', started)


def execute_stage(stage):
    directory = Path(tempfile.mkdtemp(prefix='pitchroom-ci-', dir=os.environ.get('RUNNER_TEMP')))
    log = directory / (stage + '.log')
    env = environment(stage, os.environ)
    command, workspaces, tracked, context = STAGES[stage], [], {}, {}
    if stage in ('unit', 'offline-eval'):
        context = diagnostic_context(env)
        try:
            command, workspaces = (unit_reports if stage == 'unit' else offline_reports)(directory)
            tracked = tracked_tests(env, context['head'])
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError, subprocess.TimeoutExpired):
            command, workspaces = STAGES[stage], []
    try:
        with log.open('wb') as stream:
            process = subprocess.run(command, cwd=APP, env=env, stdout=stream, stderr=subprocess.STDOUT, timeout=900)
        code = process.returncode
    except (OSError, subprocess.TimeoutExpired):
        code = 124
    print(f'{stage}: {"PASS" if code == 0 else "FAIL"}; exit={code}; raw output retained only in runner temporary directory.')
    if stage in ('unit', 'offline-eval'):
        try:
            summary = summarize_unit(workspaces, tracked, code, context) if workspaces else {'status': 'diagnostics_unavailable', 'exit': code, 'context': context, 'failures': [], 'omitted_failures': 0}
            print_unit_summary(summary, stage)
        except (OSError, ValueError, TypeError, AttributeError, RuntimeError):
            try:
                print_unit_summary({'status': 'diagnostics_unavailable', 'failures': [], 'omitted_failures': 0}, stage)
            except OSError:
                if stage != 'offline-eval':
                    raise
    summary = os.environ.get('GITHUB_STEP_SUMMARY')
    if summary:
        with open(summary, 'a') as stream:
            stream.write(f'| {stage} | {"PASS" if code == 0 else "FAIL"} | {code} |\n')
    return code


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('stage', choices=STAGES)
    raise SystemExit(run_stage(parser.parse_args().stage))
