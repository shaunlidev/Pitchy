"""Edit one owned temporary instruction block without restoring a snapshot."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path


def remove_note(current, note):
    heading = note.strip().splitlines()[0] if note.strip() else ""
    if not heading.startswith("## ") or "\n## " in note.strip():
        raise ValueError("Provide exactly one temporary level-two section")
    if current.count(heading) != 1 or current.count(note) != 1:
        raise ValueError("Owned note is missing, ambiguous or changed; do not restore a snapshot")
    start = current.index(note)
    if start and current[start - 1] != "\n" and not note.startswith("\n"):
        raise ValueError("Note must start at a section boundary")
    tail = current[start + len(note):]
    if tail.strip() and not tail.lstrip().startswith("## "):
        raise ValueError("Note does not include the complete owned section")
    return current[:start] + tail


def cli(args):
    return json.loads(subprocess.check_output(["multica", *args, "--output", "json"], text=True))


def clean(agent_id, note, expected_sha, apply=False, call=cli):
    before = call(["agent", "get", agent_id])
    current = before["instructions"]
    digest = hashlib.sha256(current.encode()).hexdigest()
    if digest != expected_sha:
        raise ValueError("Instructions changed since inspection; reread and review")
    updated = remove_note(current, note)
    if not apply:
        return {"applied": False, "before_sha256": digest,
                "after_sha256": hashlib.sha256(updated.encode()).hexdigest()}
    latest = call(["agent", "get", agent_id])
    if latest["instructions"] != current or latest["status"] != "idle":
        raise ValueError("Agent changed or is active; no write performed")
    call(["agent", "update", agent_id, "--instructions", updated])
    after = call(["agent", "get", agent_id])
    if after["instructions"] != updated:
        raise RuntimeError("Uncertain update: readback differs; stop without retry")
    return {"applied": True, "before_sha256": digest,
            "after_sha256": hashlib.sha256(updated.encode()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("agent_id")
    parser.add_argument("--remove-note-file", type=Path, required=True)
    parser.add_argument("--expected-sha256", required=True)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    print(json.dumps(clean(args.agent_id, args.remove_note_file.read_text(),
                           args.expected_sha256, args.apply)))
