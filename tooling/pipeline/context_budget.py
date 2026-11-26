#!/usr/bin/env python3
"""Bound source reads and validate one self-contained handoff; never execute work."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import sys

MAX_FILE_BYTES = 1_000_000
MAX_OUTPUT_CHARS = 24_000
BLOCKED = {'.git', '.state', '.trash', 'archive', 'node_modules', '.artifacts', '.pipeline-local', '.pipeline-artifact', '.multica', 'evidence', 'screenshots', 'prototype'}
EXTENSIONS = {'.md', '.py', '.json', '.toml', '.yaml', '.yml', '.ts', '.tsx', '.mjs', '.cjs', '.sh', '.sql', '.txt'}


def contained(root, relative):
    path = Path(relative)
    if path.is_absolute() or '..' in path.parts:
        raise ValueError('Use a contained repository-relative path')
    current = root
    for part in path.parts:
        current = current / part
        if current.is_symlink():
            raise ValueError('Symlink paths are not context inputs or receipts')
    return current


def read_sources(root, paths, context, budget, force=False):
    if not context.strip() or not 2000 <= budget <= MAX_OUTPUT_CHARS:
        raise ValueError('Use an explicit context ID and a 2000..24000 character budget')
    if not 1 <= len(paths) <= 12 or len(set(paths)) != len(paths):
        raise ValueError('Request 1..12 unique source files')
    name = hashlib.sha256(context.encode()).hexdigest()
    receipt = contained(root, f'.pipeline-local/context/{name}.json')
    seen = {}
    if receipt.exists():
        if receipt.stat().st_size > MAX_FILE_BYTES:
            raise ValueError('Oversized context receipt')
        prior = json.loads(receipt.read_text())
        if prior.get('context') != context or prior.get('root') != str(root) or prior.get('version') != 1:
            raise ValueError('Context receipt identity mismatch')
        seen = prior['files']
        if not isinstance(seen, dict) or any(not isinstance(k, str) or not isinstance(v, str) or not re.fullmatch('[a-f0-9]{64}', v) for k, v in seen.items()):
            raise ValueError('Invalid context receipt')
    result = {'context': context, 'purpose': 'source-context-only; never acceptance or permission', 'files': []}
    complete = dict(seen)
    for relative in paths:
        path = contained(root, relative)
        if len(relative) > 240 or set(Path(relative).parts) & BLOCKED or path.suffix not in EXTENSIONS or path.name.startswith('.env') or path.name == 'core-message-pitchroom-real.json':
            raise ValueError('Only explicit source text is supported; use the owning evidence/secret policy otherwise')
        if not path.is_file() or path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError('Missing, nonregular or oversized source file')
        data = path.read_bytes()
        text = data.decode('utf-8')
        digest = hashlib.sha256(data).hexdigest()
        entry = {'path': relative, 'sha256': digest, 'bytes': len(data), 'status': 'unchanged'}
        if force or seen.get(relative) != digest:
            entry['status'] = 'read'
            entry['text'] = text
            candidate = {**result, 'files': result['files'] + [entry]}
            if len(json.dumps(candidate, ensure_ascii=False)) > budget - 512:
                entry.pop('text')
                entry['status'] = 'needs_targeted_read'
                complete.pop(relative, None)
            else:
                complete[relative] = digest
        result['files'].append(entry)
    encoded = json.dumps(result, ensure_ascii=False)
    if len(encoded) > budget:
        raise ValueError('Metadata exceeds budget; request fewer files')
    # Commit the receipt only after stdout was actually delivered, not on a broken pipe.
    sys.stdout.write(encoded + '\n')
    sys.stdout.flush()
    receipt.parent.mkdir(parents=True, exist_ok=True)
    temporary = receipt.with_suffix('.tmp')
    contained(root, str(temporary.relative_to(root)))
    temporary.write_text(json.dumps({'version': 1, 'root': str(root), 'context': context, 'files': complete}))
    temporary.replace(receipt)
    return 2 if any(f['status'] == 'needs_targeted_read' for f in result['files']) else 0


HANDOFF_FIELDS = {'issue', 'role', 'head', 'scope', 'permissions', 'deliverable', 'acceptance', 'evidence', 'stop_conditions', 'report_to', 'wait_for'}


def validate_handoff(packet):
    if not isinstance(packet, dict) or set(packet) != HANDOFF_FIELDS:
        raise ValueError('Handoff must contain exactly: ' + ', '.join(sorted(HANDOFF_FIELDS)))
    if len(json.dumps(packet, ensure_ascii=False)) > 12_000:
        raise ValueError('Handoff exceeds 12000 characters; link exact scoped evidence instead')
    if not re.fullmatch(r'PIT-[1-9][0-9]*', str(packet['issue'])) or not re.fullmatch(r'[a-f0-9]{40}', str(packet['head'])):
        raise ValueError('Bind a real issue key and full immutable source commit')
    if packet['role'] not in {'developer', 'reviewer', 'qa', 'advisory'}:
        raise ValueError('Unknown handoff role')
    for key in HANDOFF_FIELDS - {'issue', 'head', 'role'}:
        value = packet[key]
        if not isinstance(value, list) or not value or any(not isinstance(v, str) or not v.strip() for v in value):
            raise ValueError(key + ' must be a nonempty list of explicit statements')
    return {'valid': True, 'issue': packet['issue'], 'head': packet['head'], 'sha256': hashlib.sha256(json.dumps(packet, sort_keys=True).encode()).hexdigest(), 'dispatch': False, 'authorization': False}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest='command', required=True)
    read = sub.add_parser('read')
    read.add_argument('paths', nargs='+')
    read.add_argument('--root', type=Path, default=Path.cwd())
    read.add_argument('--context', required=True)
    read.add_argument('--budget', type=int, default=12_000)
    read.add_argument('--force', action='store_true')
    handoff = sub.add_parser('handoff')
    handoff.add_argument('path', type=Path)
    args = parser.parse_args()
    try:
        if args.command == 'read':
            return read_sources(args.root.resolve(), args.paths, args.context, args.budget, args.force)
        if args.path.stat().st_size > MAX_FILE_BYTES:
            raise ValueError('Oversized handoff')
        print(json.dumps(validate_handoff(json.loads(args.path.read_text()))))
        return 0
    except (ValueError, OSError, KeyError, TypeError) as error:
        print(json.dumps({'error': str(error), 'acceptance': 'unknown'}), file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
