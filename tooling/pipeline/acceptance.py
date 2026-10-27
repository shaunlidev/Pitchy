"""Fail-closed engineering acceptance for a frozen artifact and contract.

This module does not execute commands or trust an agent's PASS declaration.
The controller must be the sole writer of ``evidence_root``; keep that directory
outside every agent-writable checkout. A producer string is not authentication.

Contract v1:
  {schema_version:1, engineering:true, description_sha256:SHA256, decisions:[],
   criteria:[{id,text,kind:"engineering",required:true,check_ids:[CHECK_ID]}],
   checks:{CHECK_ID:{argv:[STR,...],cwd:RELATIVE_PATH,
                    proof:{kind:"json",pointer:"/passed",equals:true}}}}
``proof.kind=regex`` alternatively requires a ``pattern`` matched against the
entire stdout with re.fullmatch, not a substring PASS search. Criterion coverage
is frozen by the contract hash; the controller/reviewer must first establish that
this mapping covers the full original description. Hashing cannot infer semantics.

Artifact:
  {issue,commit,tree,generation,contract_sha256,description_sha256,
   actors:{developer:ID,reviewer:ID,qa:ID}}
Role receipt (one per role):
  {role,actor_id,run_id, <all six artifact identity fields>, dirty:false,
   criterion_results:[{id,status:"pass"}],gaps:[],decisions:[]}
The reviewer must additionally attest ``complete_contract_review:true`` after
independently comparing the frozen mapping with the original full description.
Controller check receipt at ``checks/CHECK_ID.json``:
  {schema_version:1,producer:"controller",check_id,<artifact identity fields>,
   argv,cwd,exit_code:0,dirty:false,assertion_passed:true,
   stdout_log:"logs/CHECK_ID.stdout",stdout_sha256:SHA256}
The raw stdout must exist under evidence_root, match its hash, and independently
satisfy the approved proof matcher. Missing, duplicate, stale, waived, subjective,
failed, skipped, unexecuted or mutated-source evidence never completes an issue.
"""
import hashlib
import json
from pathlib import Path, PurePosixPath
import re


class AcceptanceError(ValueError):
    pass


IDENTITY = ("issue", "commit", "tree", "generation", "contract_sha256", "description_sha256")
ROLES = ("developer", "reviewer", "qa")
SAFE_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,63}")
SHA256 = re.compile(r"[0-9a-f]{64}")
GIT_SHA = re.compile(r"(?:[0-9a-f]{40}|[0-9a-f]{64})")


def _require(condition, message):
    if not condition:
        raise AcceptanceError(message)


def contract_digest(contract):
    try:
        data = json.dumps(contract, sort_keys=True, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as e:
        raise AcceptanceError("contract is not canonical JSON") from e
    return hashlib.sha256(data.encode("utf-8")).hexdigest()


def _safe_id(value):
    return isinstance(value, str) and SAFE_ID.fullmatch(value) is not None


def _relative(value):
    return (isinstance(value, str) and bool(value) and "\\" not in value
            and not PurePosixPath(value).is_absolute()
            and ".." not in PurePosixPath(value).parts)


def _check_proof(proof):
    _require(isinstance(proof, dict), "approved proof matcher required")
    if proof.get("kind") == "json":
        pointer = proof.get("pointer")
        _require(isinstance(pointer, str) and (pointer == "" or pointer.startswith("/")), "invalid JSON proof pointer")
        _require("equals" in proof, "JSON proof needs an exact expected value")
        contract_digest(proof["equals"])
    elif proof.get("kind") == "regex":
        _require(isinstance(proof.get("pattern"), str) and bool(proof["pattern"]), "empty regex proof")
        try:
            re.compile(proof["pattern"])
        except re.error as e:
            raise AcceptanceError("invalid regex proof") from e
    else:
        raise AcceptanceError("unsupported proof matcher")


def validate_contract(contract, description_sha):
    """Validate a previously frozen complete mapping; never waive criteria."""
    _require(isinstance(contract, dict), "contract must be an object")
    _require(type(contract.get("schema_version")) is int and contract["schema_version"] == 1, "unsupported contract schema")
    _require(contract.get("engineering") is True, "only engineering contracts may auto-complete")
    _require(isinstance(description_sha, str) and SHA256.fullmatch(description_sha), "invalid source-description fingerprint")
    _require(contract.get("description_sha256") == description_sha, "description changed after contract freeze")
    _require(contract.get("decisions") == [], "unresolved contract decisions")
    criteria, checks = contract.get("criteria"), contract.get("checks")
    _require(isinstance(criteria, list) and bool(criteria), "nonempty frozen criteria required")
    _require(isinstance(checks, dict) and bool(checks), "registered machine checks required")
    ids, used = set(), set()
    for criterion in criteria:
        _require(isinstance(criterion, dict), "criterion must be an object")
        key = criterion.get("id")
        _require(_safe_id(key) and key not in ids, "invalid or duplicate criterion id")
        ids.add(key)
        _require(isinstance(criterion.get("text"), str) and bool(criterion["text"].strip()), "empty criterion text")
        _require(criterion.get("required") is True, "criteria cannot be waived or made optional")
        _require(criterion.get("kind") == "engineering", "subjective/human criterion requires a decision")
        references = criterion.get("check_ids")
        _require(isinstance(references, list) and bool(references), "each criterion needs a machine proof")
        _require(all(_safe_id(x) for x in references) and len(set(references)) == len(references), "invalid/duplicate check reference")
        _require(all(x in checks for x in references), "criterion references an unregistered check")
        used.update(references)
    _require(used == set(checks), "checks must map exactly to frozen criteria")
    for key, check in checks.items():
        _require(_safe_id(key) and isinstance(check, dict), "invalid check definition")
        argv = check.get("argv")
        _require(isinstance(argv, list) and bool(argv) and all(isinstance(x, str) and bool(x) and "\x00" not in x for x in argv), "exact nonempty argv required")
        _require(_relative(check.get("cwd")), "check cwd must stay in artifact checkout")
        _check_proof(check.get("proof"))
    contract_digest(contract)


def _identity(record, artifact, label):
    _require(isinstance(record, dict), label + " must be an object")
    for field in IDENTITY:
        _require(type(record.get(field)) is type(artifact[field]) and record.get(field) == artifact[field], label + " has stale/wrong " + field)


def _no_gaps(record, label):
    _require(record.get("dirty") is False, label + " changed or did not fingerprint the source")
    for key in ("gaps", "decisions"):
        _require(record.get(key) == [], label + " has missing/unresolved " + key)
    for key in ("failures", "skipped", "not_run"):
        _require(key not in record or record[key] == [], label + " has " + key)


def _owned_file(root, relative):
    _require(_relative(relative) and relative != ".", "invalid evidence path")
    candidate = root / relative
    try:
        candidate.resolve(strict=True).relative_to(root)
        current = root
        for part in PurePosixPath(relative).parts:
            current = current / part
            _require(not current.is_symlink(), "symlink evidence is not controller-owned")
        _require(candidate.is_file() and candidate.stat().st_size <= 16 * 1024 * 1024, "missing or oversized evidence file")
    except (OSError, ValueError) as e:
        raise AcceptanceError("missing/outside evidence file") from e
    return candidate


def _matches(stdout, proof):
    if proof["kind"] == "regex":
        return re.fullmatch(proof["pattern"], stdout) is not None
    try:
        value = json.loads(stdout)
        if proof["pointer"]:
            for token in proof["pointer"][1:].split("/"):
                token = token.replace("~1", "/").replace("~0", "~")
                if isinstance(value, list):
                    _require(token.isdigit(), "invalid array proof pointer")
                    value = value[int(token)]
                else:
                    value = value[token]
        # JSON true is not numeric 1, despite Python's equality behavior.
        return contract_digest(value) == contract_digest(proof["equals"])
    except (ValueError, TypeError, KeyError, IndexError, AcceptanceError):
        return False


def evaluate_proof(proof, stdout_text):
    """Apply the same approved matcher used by final acceptance to raw stdout."""
    _check_proof(proof)
    _require(isinstance(stdout_text, str), "machine stdout must be decoded text")
    return _matches(stdout_text, proof)


def validate_completion(contract, artifact, developer, reviewer, qa, evidence_root):
    """Return an eligible decision or raise; no side effects and no status write."""
    _require(isinstance(artifact, dict), "artifact must be an object")
    _require(isinstance(artifact.get("issue"), str) and re.fullmatch(r"PIT-[1-9][0-9]*", artifact["issue"]), "invalid artifact issue")
    _require(type(artifact.get("generation")) is int and artifact["generation"] >= 1, "invalid artifact generation")
    for field in ("commit", "tree"):
        _require(isinstance(artifact.get(field), str) and GIT_SHA.fullmatch(artifact[field]), "full Git " + field + " required")
    validate_contract(contract, artifact.get("description_sha256"))
    _require(artifact.get("contract_sha256") == contract_digest(contract), "artifact contract fingerprint mismatch")
    actors = artifact.get("actors")
    _require(isinstance(actors, dict) and set(actors) == set(ROLES), "configured actor identities required")
    _require(all(isinstance(x, str) and bool(x) for x in actors.values()) and len(set(actors.values())) == 3, "independent configured actors required")
    expected = {x["id"] for x in contract["criteria"]}
    run_ids = set()
    for role, report in zip(ROLES, (developer, reviewer, qa)):
        _identity(report, artifact, role)
        _require(report.get("role") == role and report.get("actor_id") == actors[role], "wrong configured " + role + " identity")
        run_id = report.get("run_id")
        _require(isinstance(run_id, str) and bool(run_id) and run_id not in run_ids, "independent stage run identities required")
        run_ids.add(run_id)
        _no_gaps(report, role)
        if role == "reviewer":
            _require(report.get("complete_contract_review") is True, "reviewer did not certify full original-contract coverage")
        results = report.get("criterion_results")
        _require(isinstance(results, list) and len(results) == len(expected), role + " criterion coverage is incomplete")
        seen = set()
        for result in results:
            _require(isinstance(result, dict), "invalid criterion result")
            key = result.get("id")
            _require(key in expected and key not in seen and result.get("status") == "pass", role + " has duplicate, unregistered or nonpassing criterion")
            seen.add(key)
        _require(seen == expected, role + " criterion coverage mismatch")
    try:
        root = Path(evidence_root).resolve(strict=True)
        _require(root.is_dir(), "controller evidence root is unavailable")
    except OSError as e:
        raise AcceptanceError("controller evidence root is unavailable") from e
    for key, approved in contract["checks"].items():
        try:
            receipt = json.loads(_owned_file(root, "checks/" + key + ".json").read_text())
        except (OSError, ValueError) as e:
            raise AcceptanceError("missing/invalid controller check receipt") from e
        _identity(receipt, artifact, "check " + key)
        _require(receipt.get("schema_version") == 1 and receipt.get("producer") == "controller" and receipt.get("check_id") == key, "check is not a controller receipt")
        _require(receipt.get("argv") == approved["argv"] and receipt.get("cwd") == approved["cwd"], "executed check differs from approved command")
        _require(type(receipt.get("exit_code")) is int and receipt["exit_code"] == 0, "machine check failed or did not execute")
        _require(receipt.get("dirty") is False and receipt.get("assertion_passed") is True, "machine proof absent or source changed")
        stdout = _owned_file(root, receipt.get("stdout_log")).read_bytes()
        _require(receipt.get("stdout_sha256") == hashlib.sha256(stdout).hexdigest(), "machine log fingerprint mismatch")
        try:
            decoded = stdout.decode("utf-8")
        except UnicodeError as e:
            raise AcceptanceError("machine log must be UTF-8") from e
        _require(evaluate_proof(approved["proof"], decoded), "approved machine assertion failed")
    return {"eligible": True, "issue": artifact["issue"], "generation": artifact["generation"],
            "commit": artifact["commit"], "tree": artifact["tree"],
            "contract_sha256": artifact["contract_sha256"],
            "criteria": sorted(expected), "checks": sorted(contract["checks"])}
