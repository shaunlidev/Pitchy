#!/usr/bin/env python3
"""Canonical two-lane controller. Worktree code never owns scheduling state."""
import argparse
import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import sqlite3
import subprocess
import sys
import time

from acceptance import AcceptanceError, contract_digest, evaluate_proof, validate_contract, validate_completion
from artifacts import ArtifactError, verify_squash_merge, checkpoint, has_ancestor, materialize, prepare_dependencies, verify_clean_tree, verify_dependencies, checkpoint_runtime_metadata

CONTROL = Path(__file__).resolve().parent
STATE = CONTROL / ".state" / "v2"
ACTIVE = {"todo", "in_progress", "started_2", "started_3"}
RUNNING = {"queued", "dispatched", "running", "waiting_local_directory", "deferred"}
ROLES = ("developer", "reviewer", "qa")


class Hold(ValueError):
    pass


def digest(text):
    return hashlib.sha256(text.encode()).hexdigest()


def write_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
    temporary.replace(path)


def requirements(description):
    """Freeze verbatim latest observable ACs, retaining the entire source too."""
    if "### 7. Observable acceptance" in description:
        section = description.rsplit("### 7. Observable acceptance", 1)[1].split("### 8.", 1)[0]
        rows = re.findall(r"^- \[ \] (.+)$", section, re.M)
    elif "## 7. 验收草案" in description:
        section = description.rsplit("## 7. 验收草案", 1)[1].split("## 8.", 1)[0]
        rows = [line.strip() for line in section.splitlines() if line.strip()]
    elif "验收条件：" in description:
        section = description.rsplit("验收条件：", 1)[1].split("交付规则", 1)[0]
        rows = re.findall(r"^- (.+)$", section, re.M)
    else:
        rows = []
    if not rows:
        raise Hold("no complete observable acceptance inventory; needs contract clarification")
    return [{"id": "AC-" + str(i + 1), "text": text} for i, text in enumerate(rows)]


def git(root, *args):
    return subprocess.check_output(["git", "-C", str(root), *args], text=True).strip()


@contextlib.contextmanager
def lock(root=STATE, name="controller", wait=0):
    root.mkdir(parents=True, exist_ok=True)
    with (root / (name + ".lock")).open("a") as f:
        deadline = time.monotonic() + wait
        while True:
            try:
                fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
                break
            except BlockingIOError as e:
                if time.monotonic() >= deadline:
                    raise Hold("controller busy; no side effect attempted") from e
                time.sleep(0.1)
        yield


class Controller:
    def __init__(self, config, call, state=STATE):
        self.c, self.call, self.root = config, call, Path(state)
        self.root.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.root / "ledger.sqlite3")
        self.db.execute("CREATE TABLE IF NOT EXISTS lanes (issue TEXT PRIMARY KEY, data TEXT NOT NULL)")
        self.db.execute("CREATE TABLE IF NOT EXISTS operations (token TEXT PRIMARY KEY, state TEXT NOT NULL)")
        self.db.commit()

    def close(self):
        self.db.close()

    def lanes(self):
        return {k: json.loads(v) for k, v in self.db.execute("SELECT issue,data FROM lanes")}

    def save(self, lane):
        self.db.execute("INSERT OR REPLACE INTO lanes VALUES (?,?)", (lane["issue"], json.dumps(lane)))
        self.db.commit()

    def reserve(self, token):
        if self.db.execute("SELECT 1 FROM operations WHERE state='uncertain'").fetchone():
            raise Hold("uncertain operation requires reconciliation")
        try:
            self.db.execute("INSERT INTO operations VALUES (?,'uncertain')", (token,))
            self.db.commit()
        except sqlite3.IntegrityError as e:
            raise Hold("operation already attempted; no automatic replay") from e

    def finish(self, token):
        self.db.execute("UPDATE operations SET state='confirmed' WHERE token=?", (token,))
        self.db.commit()

    def issues(self):
        data = self.call(["issue", "list", "--project", self.c["project"], "--limit", "100", "--output", "json"])
        if data.get("has_more"):
            raise Hold("partial project listing; refuse scheduling")
        return data["issues"]

    def issue(self, key):
        return next(x for x in self.issues() if x["identifier"] == key)

    def dependencies(self, issue, all_issues, base=None):
        raw = issue.get("metadata", {}).get("depends_on", "[]")
        try:
            keys = json.loads(raw) if isinstance(raw, str) else raw
        except (ValueError, TypeError) as e:
            raise Hold("invalid dependency list") from e
        if not isinstance(keys, list) or any(not isinstance(k, str) for k in keys):
            raise Hold("invalid dependency list")
        by_key, lanes = {x["identifier"]: x for x in all_issues}, self.lanes()
        for key in keys:
            if key == issue["identifier"] or by_key.get(key, {}).get("status") != "done":
                raise Hold("unaccepted prerequisite: " + key)
            artifact = lanes.get(key, {}).get("artifact")
            if not artifact:
                if key not in self.c.get("legacy_dependencies", {}):
                    raise Hold("accepted prerequisite artifact unavailable: " + key)
                required = self.c["legacy_dependencies"][key]
            else:
                integration = lanes[key].get("integration")
                if integration:
                    if integration.get("head") != artifact["commit"] or integration.get("method") != "squash":
                        raise Hold("prerequisite integration identity differs: " + key)
                    try:
                        verify_squash_merge(self.c["repository"], artifact["commit"], integration["commit"], integration["parent"])
                    except (ArtifactError, KeyError) as error:
                        raise Hold("prerequisite squash proof unavailable: " + key) from error
                    required = integration["commit"]
                else:
                    required = artifact["commit"]
            base_commit = base or git(self.c["repository"], "rev-parse", "HEAD")
            if not has_ancestor(self.c["repository"], required, base_commit):
                raise Hold("prerequisite not integrated in base; no auto merge: " + key)

    def active_issues(self, issues):
        active = {x["identifier"] for x in issues if x["status"] in ACTIVE}
        # A role may have posted in_review before its process actually exits.
        for issue in issues:
            if issue.get("assignee_id") and issue["status"] not in ACTIVE:
                runs = self.call(["issue", "runs", issue["id"], "--output", "json"])
                if not isinstance(runs, list):
                    raise Hold("unknown run history shape")
                if any(x.get("status") in RUNNING for x in runs):
                    active.add(issue["identifier"])
        return active

    def dispatch(self, apply=False):
        issues, lanes = self.issues(), self.lanes()
        active = self.active_issues(issues)
        slots = max(0, self.c.get("max_lanes", 2) - len(active))
        result = {"active": sorted(active), "slots": slots, "started": [], "held": {}}
        order = self.c.get("order", [])
        for item in sorted(issues, key=lambda x: (order.index(x["identifier"]) if x["identifier"] in order else 999, x.get("number", 999))):
            key = item["identifier"]
            if item["status"] != "backlog":
                continue
            try:
                if item.get("metadata", {}).get("automation_mode") != "dependency_queue":
                    raise Hold("summary/deferred/not enrolled")
                if key in self.c.get("decision_holds", {}):
                    raise Hold(self.c["decision_holds"][key])
                if item.get("assignee_id") not in (None, self.c["developer"]):
                    raise Hold("owned by another handler")
                if key in lanes:
                    raise Hold("lane already reserved; no duplicate start")
                self.dependencies(item, issues)
                required = requirements(item.get("description") or "")
            except Hold as e:
                result["held"][key] = str(e)
                continue
            if slots <= 0:
                break
            if not apply:
                result.setdefault("candidates", []).append(key)
                slots -= 1
                continue
            self.reserve("start:" + item["id"])
            fresh = self.issue(key)
            if fresh["status"] != "backlog" or fresh.get("description") != item.get("description"):
                raise Hold("task changed before dispatch")
            self.dependencies(fresh, self.issues())
            lane = {"issue": key, "id": item["id"], "generation": 1, "phase": "developer",
                    "description": item.get("description") or "", "requirements": required,
                    "description_sha256": digest(item.get("description") or ""), "repairs": 0}
            self.save(lane)
            self.call(["issue", "assign", item["id"], "--to-id", self.c["developer"], "--no-start"])
            self.call(["issue", "update", item["id"], "--status", "todo", "--output", "json"])
            self.finish("start:" + item["id"])
            result["started"].append(key)
            slots -= 1
        return result

    def preserved_runtime_source(self, lane, issue, approval):
        source = approval.get("preserved_source")
        if source is None:
            return None
        if not isinstance(source, dict) or any(not isinstance(source.get(k), str) or not source[k] for k in ("commit", "base", "run_id")):
            raise Hold("preserved runtime source requires immutable commit/base and the actual run")
        runs = self.call(["issue", "runs", issue["id"], "--output", "json"])
        if not isinstance(runs, list):
            raise Hold("unknown preserved runtime history")
        matches = [r for r in runs if r.get("id") == source["run_id"] and r.get("issue_id") == issue["id"]
                   and r.get("agent_id") == self.c["developer"] and r.get("status") == "completed"]
        if len(matches) != 1:
            raise Hold("source checkpoint is not bound to a completed developer run of this issue")
        branch = (matches[0].get("result") or {}).get("branch_name")
        if not isinstance(branch, str) or not branch:
            raise Hold("native runtime branch record missing")
        repo = self.c["repository"]
        try:
            git(repo, "check-ref-format", "refs/heads/" + branch)
            tip = source.get("runtime_tip", source["commit"])
            if git(repo, "rev-parse", "--verify", "refs/heads/" + branch) != tip:
                raise Hold("preserved native source branch changed")
            if tip != source["commit"]:
                if lane.get("artifact", {}).get("commit") != source["commit"]:
                    raise Hold("runtime wrapper must preserve the exact staged artifact")
                if git(repo, "show", "-s", "--format=%P", tip) != source["commit"]:
                    raise Hold("runtime wrapper must directly follow the staged artifact")
                if git(repo, "diff", "--name-only", source["commit"], tip).splitlines() != ["AGENTS.md"]:
                    raise Hold("runtime wrapper contains application changes")
            record_ref = "refs/multica/local-state/" + branch
            record = git(repo, "show", "-s", "--format=%P%n%B", record_ref)
            parents = record.splitlines()[0].split()
            if len(parents) != 2 or parents[1] != tip:
                raise Hold("native branch record does not bind the saved source tip")
            for name, value in (("Workspace", self.c["workspace"]), ("Agent", self.c["developer"]), ("Conversation", issue["id"])):
                if "Multica-" + name + ": " + value not in record.splitlines():
                    raise Hold("native source record belongs to another runtime identity")
            if git(repo, "rev-parse", source["commit"] + "^") != source["base"]:
                raise Hold("saved runtime checkpoint has a different baseline")
            changed = git(repo, "diff", "--name-only", source["base"], source["commit"]).splitlines()
            allowed = lane.get("contract", {}).get("allowed_paths", [])
            if not changed or set(changed) - set(allowed):
                raise Hold("saved source checkpoint contains undeclared task paths")
            prior = lane.get("artifact", {}).get("commit") or lane.get("rework_base_commit")
            if prior and not has_ancestor(repo, prior, source["commit"]):
                raise Hold("preserved source omits the earlier delivery")
            record_commit = git(repo, "rev-parse", record_ref)
        except subprocess.CalledProcessError as e:
            raise Hold("cannot verify immutable native source record") from e
        return {**source, "branch": branch, "record_commit": record_commit, "changed_paths": changed,
                "verified_delivery": False}

    def resolve(self, key, report, expected_generation, expected_revision, apply=False):
        """Explicit human decision re-entry, preserving every prior held generation."""
        with lock(self.root, wait=45):
            if self.db.execute("SELECT 1 FROM operations WHERE state='uncertain'").fetchone():
                raise Hold("uncertain operation requires reconciliation")
            try:
                path = Path(report).resolve()
                path.relative_to(Path(self.c["repository"]).resolve())
                approval = json.loads(path.read_text())
            except (OSError, ValueError) as e:
                raise Hold("resolution must be a JSON receipt inside the repository") from e
            if (not isinstance(approval, dict) or approval.get("issue") != key
                    or not isinstance(approval.get("authority"), str) or not approval["authority"].strip()
                    or not isinstance(approval.get("approvedRules"), list) or not approval["approvedRules"]
                    or any(not isinstance(x, str) or not x.strip() for x in approval["approvedRules"])):
                raise Hold("explicit issue-specific human resolution required")
            lane = self.lanes().get(key)
            if not lane or lane["phase"] != "held" or lane["generation"] != expected_generation:
                raise Hold("held generation changed; no silent replay")
            if lane.get("repairs", 0) >= 2:
                raise Hold("repair cap exhausted; no third automatic repair")
            issues = self.issues()
            issue = next(x for x in issues if x["identifier"] == key)
            if issue["status"] not in {"in_review", "blocked"} or issue.get("revision") != expected_revision:
                raise Hold("held issue revision or status changed")
            description = issue.get("description") or ""
            if digest(description) != approval.get("description_sha256"):
                raise Hold("approval does not bind to the actual clarified contract")
            if not description.rstrip().endswith(lane["description"].rstrip()) or requirements(description) != lane["requirements"]:
                raise Hold("original contract and complete criteria must be retained unchanged")
            active = {x["identifier"] for x in issues if x["status"] in ACTIVE}
            for row in issues:
                if row.get("assignee_id") or row["identifier"] == key:
                    runs = self.call(["issue", "runs", row["id"], "--output", "json"])
                    if not isinstance(runs, list):
                        raise Hold("unknown run history shape")
                    if any(r.get("status") in RUNNING for r in runs):
                        active.add(row["identifier"])
            if key in active or len(active) >= self.c.get("max_lanes", 2):
                raise Hold("target still running or no issue lane available")
            self.dependencies(issue, issues)
            preserved = self.preserved_runtime_source(lane, issue, approval)
            prior_commit = (preserved or {}).get("commit") or lane.get("artifact", {}).get("commit") or lane.get("rework_base_commit")
            if prior_commit and not preserved and not has_ancestor(self.c["repository"], prior_commit, git(self.c["repository"], "rev-parse", "HEAD")):
                raise Hold("prior delivery requires explicit integration; no silent rebase")
            generation = expected_generation + 1
            if not apply:
                return {"issue": key, "status": "todo", "generation": generation, "dry_run": True}
            archive = self.root / "resolutions" / (key + "-g" + str(expected_generation) + "-r" + str(expected_revision) + ".json")
            if archive.exists():
                raise Hold("resolution already recorded; reconcile instead of replaying")
            token = "resolve:" + issue["id"] + ":" + str(expected_generation) + ":" + str(expected_revision)
            self.reserve(token)
            write_json(archive, {"lane": lane, "approval": approval, "remote_revision": expected_revision})
            updated = json.loads(json.dumps(lane))
            updated.setdefault("prior_generations", []).append(str(archive))
            updated.update(generation=generation, phase="developer", description=description,
                           description_sha256=digest(description), requirements=requirements(description), resolution=str(archive))
            if prior_commit:
                updated["rework_base_commit"] = prior_commit
            if preserved:
                updated["preserved_source"] = preserved
            for name in ("artifact", "receipts", "checkouts", "contract", "developer_workspace", "dependencies"):
                updated.pop(name, None)
            self.save(updated)
            # A human comment itself wakes the handler. The approval is already
            # in the saved contract; only the status transition starts this run.
            self.call(["issue", "assign", issue["id"], "--to-id", self.c["developer"], "--no-start"])
            fresh = self.issue(key)
            if fresh["status"] != issue["status"] or fresh.get("assignee_id") != self.c["developer"] or digest(fresh.get("description") or "") != digest(description):
                raise Hold("task changed during resolution")
            self.dependencies(fresh, self.issues())
            self.call(["issue", "update", issue["id"], "--status", "todo", "--output", "json"])
            self.finish(token)
            return {"issue": key, "status": "todo", "generation": generation, "resolved": True}

    def actor(self, role):
        actor, run = os.environ.get("MULTICA_AGENT_ID"), os.environ.get("MULTICA_TASK_ID")
        if actor != self.c[role] or not run:
            raise Hold("this operation requires the assigned role's actual runtime identity")
        return actor, run

    def current(self, key, role):
        actor, run = self.actor(role)
        lane = self.lanes().get(key)
        if not lane or lane["phase"] != role:
            raise Hold("wrong or stale lane stage")
        issue = self.issue(key)
        runs = self.call(["issue", "runs", issue["id"], "--output", "json"])
        matches = [r for r in runs if r.get("id") == run and r.get("issue_id") == issue["id"] and r.get("agent_id") == actor and r.get("status") == "running"]
        if len(matches) != 1 or not matches[0].get("work_dir"):
            raise Hold("runtime is not an active run of this ticket and role with a known workspace")
        native = Path(matches[0]["work_dir"]).resolve()
        if Path.cwd().resolve() != native:
            raise Hold("execute from the actual native runtime workspace")
        expected_status = {"developer": {"todo", "in_progress"}, "reviewer": {self.c["review_status"]}, "qa": {self.c["qa_status"]}}[role]
        if issue["status"] not in expected_status:
            raise Hold("issue is no longer in this role's current workflow step")
        if issue.get("assignee_id") != self.c[role] or digest(issue.get("description") or "") != lane["description_sha256"]:
            raise Hold("handler or acceptance source changed")
        base = lane.get("artifact", {}).get("commit") or git(native, "rev-parse", "HEAD")
        if lane.get("rework_base_commit") and not has_ancestor(self.c["repository"], lane["rework_base_commit"], base):
            raise Hold("rework workspace omits prior delivery; explicit integration required")
        self.dependencies(issue, self.issues(), base)
        return lane, issue

    def plan(self, key, path):
        lane, _ = self.current(key, "developer")
        if lane.get("artifact"):
            raise Hold("artifact already frozen")
        plan = json.loads(Path(path).read_text())
        if plan.get("engineering") is not True:
            raise Hold("explicit engineering classification required; no automatic reclassification")
        plan.update(schema_version=1, description_sha256=lane["description_sha256"])
        expected = lane["requirements"]
        actual = [{"id": x.get("id"), "text": x.get("text")} for x in plan.get("criteria", [])]
        if actual != expected:
            raise Hold("plan must preserve every frozen acceptance criterion verbatim and in order")
        validate_contract(plan, lane["description_sha256"])
        paths = plan.get("allowed_paths")
        if not isinstance(paths, list) or not paths or any(not isinstance(x, str) for x in paths):
            raise Hold("explicit task path inventory required")
        lane["contract"] = plan
        self.save(lane)
        return {"issue": key, "contract_sha256": contract_digest(plan), "criteria": expected}

    def workspace(self, key, workdir):
        lane, _ = self.current(key, "developer")
        workdir = Path(workdir).resolve()
        if workdir != Path.cwd().resolve():
            raise Hold("workspace must be this ticket run native workspace")
        self.dependencies(self.issue(key), self.issues(), git(workdir, "rev-parse", "HEAD"))
        if workdir == Path(self.c["repository"]).resolve():
            raise Hold("development must use an isolated native worktree")
        if git(workdir, "rev-parse", "--path-format=absolute", "--git-common-dir") != git(self.c["repository"], "rev-parse", "--path-format=absolute", "--git-common-dir"):
            raise Hold("wrong repository")
        if lane.get("developer_workspace"):
            if lane["developer_workspace"] != str(workdir):
                raise Hold("workspace already bound to another path")
            return {"workdir": str(workdir), "dependencies": lane["dependencies"], "requirements": lane["requirements"]}
        dependencies = prepare_dependencies(self.c["repository"], workdir)
        lane.update(developer_workspace=str(workdir), dependencies=dependencies)
        self.save(lane)
        return {"workdir": str(workdir), "dependencies": dependencies, "requirements": lane["requirements"], "description": lane["description"]}

    def checkout(self, key, role, workdir):
        lane, _ = self.current(key, role)
        artifact = lane.get("artifact")
        if not artifact:
            raise Hold("developer artifact not published")
        workdir = Path(workdir).resolve()
        if workdir != Path.cwd().resolve():
            raise Hold("checkout parent must be this ticket run native workspace")
        common = git(workdir, "rev-parse", "--path-format=absolute", "--git-common-dir")
        if common != git(self.c["repository"], "rev-parse", "--path-format=absolute", "--git-common-dir"):
            raise Hold("native worktree belongs to another repository")
        _, run = self.actor(role)
        destination = workdir / ".pipeline-artifact" / (key + "-" + run)
        if destination.exists():
            verify_clean_tree(destination, artifact["tree"])
            if lane.get("checkouts", {}).get(role) != str(destination):
                raise Hold("unregistered preexisting checkout")
        else:
            destination.parent.mkdir(parents=True, exist_ok=True)
            materialize(self.c["repository"], artifact["commit"], destination)
            dependencies = prepare_dependencies(self.c["repository"], destination)
            if dependencies["sha256"] != lane["dependencies"]["sha256"]:
                raise Hold("installed dependencies changed since developer workspace preparation")
        lane.setdefault("checkouts", {})[role] = str(destination)
        self.save(lane)
        return {"checkout": str(destination), "artifact": artifact, "contract": lane["contract"]}

    def checks(self, lane, role, checkout_path):
        contract, artifact = lane["contract"], lane["artifact"]
        root = self.root / "evidence" / lane["issue"] / str(lane["generation"]) / role
        if root.exists():
            raise Hold("stage evidence already exists; do not rerun an uncertain check")
        root.mkdir(parents=True)
        verify_dependencies(checkout_path, lane["dependencies"])
        verify_clean_tree(checkout_path, artifact["tree"])
        for key, check in contract["checks"].items():
            cwd = (Path(checkout_path) / check["cwd"]).resolve()
            cwd.relative_to(Path(checkout_path).resolve())
            env = {k: v for k, v in os.environ.items() if k in ("PATH", "HOME", "TMPDIR", "SYSTEMROOT")}
            env.update(CI="1", PITCHROOM_DELIVERY_COMMIT=artifact["commit"], PITCHROOM_DELIVERY_TREE=artifact["tree"], PITCHROOM_ISOLATED_QA="1")
            try:
                proc = subprocess.run(check["argv"], cwd=cwd, env=env, capture_output=True, text=True, timeout=180)
                code, stdout, stderr = proc.returncode, proc.stdout, proc.stderr
            except subprocess.TimeoutExpired as e:
                code, stdout, stderr = 124, "", "approved check timed out"
            logs = root / "logs"
            logs.mkdir(exist_ok=True)
            (logs / (key + ".stdout")).write_text(stdout)
            (logs / (key + ".stderr")).write_text(stderr)
            verify_clean_tree(checkout_path, artifact["tree"])
            verify_dependencies(checkout_path, lane["dependencies"])
            write_json(root / "checks" / (key + ".json"), {**{k: artifact[k] for k in ("issue", "commit", "tree", "generation", "contract_sha256", "description_sha256")},
                "schema_version": 1, "producer": "controller", "check_id": key, "argv": check["argv"], "cwd": check["cwd"], "exit_code": code,
                "dirty": False, "assertion_passed": code == 0 and evaluate_proof(check["proof"], stdout), "stdout_log": "logs/" + key + ".stdout", "stdout_sha256": digest(stdout)})
        return root

    def transition(self, lane, issue, target, report):
        # Only remote side effects share the queue lock. Copies and checks are
        # serialized per issue, allowing genuinely independent issue lanes.
        with lock(self.root, wait=45):
            return self._transition(lane, issue, target, report)

    def _transition(self, lane, issue, target, report):
        token = "transition:" + lane["issue"] + ":" + str(lane["generation"]) + ":" + lane["phase"]
        self.reserve(token)
        # CLI file arguments must live inside the task's actual working directory.
        local_report = Path.cwd() / (".pipeline-handoff-" + lane["issue"] + ".json")
        local_report.write_text(Path(report).read_text())
        self.call(["issue", "comment", "add", issue["id"], "--content-file", str(local_report)])
        fresh = self.issue(lane["issue"])
        if fresh["status"] != issue["status"] or fresh.get("assignee_id") != issue.get("assignee_id"):
            raise Hold("issue moved during transition")
        self.dependencies(fresh, self.issues(), lane.get("artifact", {}).get("commit"))
        if digest(fresh.get("description") or "") != lane["description_sha256"]:
            raise Hold("original contract changed during transition")
        self.call(["issue", "update", issue["id"], "--status", target, "--output", "json", *(["--no-start"] if target in ("done", "in_review", "blocked") else [])])
        self.finish(token)

    def return_to_owner(self, key, role, report, rework=False):
        lane, issue = self.current(key, role)
        note = json.loads(Path(report).read_text())
        if not note.get("gaps") and not note.get("decisions"):
            raise Hold("a concrete gap, defect or decision is required")
        target = "todo" if rework and role in ("reviewer", "qa") and lane["repairs"] < 2 else "in_review"
        output = self.root / "returns" / (key + "-" + str(lane["generation"]) + "-" + role + ".json")
        write_json(output, note)
        self.transition(lane, issue, target, output)
        if target == "todo":
            lane["rework_base_commit"] = lane["artifact"]["commit"]
            lane.update(generation=lane["generation"] + 1, repairs=lane["repairs"] + 1, phase="developer")
            for name in ("artifact", "receipts", "checkouts", "contract", "developer_workspace", "dependencies"):
                lane.pop(name, None)
        else:
            lane["phase"] = "held"
        self.save(lane)
        return {"issue": key, "status": target, "gaps": note.get("gaps", [])}

    def publish_checkpoint(self, lane, workdir, key):
        checkpoint_runtime_metadata(workdir, key, lane["generation"], repository=self.c["repository"])
        return checkpoint(Path(workdir), key, lane["generation"], lane["contract"]["allowed_paths"], repository=self.c["repository"])

    def stage(self, key, role, report, workdir):
        lane, issue = self.current(key, role)
        note = json.loads(Path(report).read_text())
        actor, run = self.actor(role)
        if role == "developer":
            if "contract" not in lane:
                raise Hold("register a complete executable plan first")
            if lane.get("developer_workspace") != str(Path(workdir).resolve()):
                raise Hold("prepare and bind the actual isolated developer workspace first")
            verify_dependencies(workdir, lane["dependencies"])
            self.dependencies(issue, self.issues(), git(workdir, "rev-parse", "HEAD"))
            commit = self.publish_checkpoint(lane, workdir, key)
            self.dependencies(issue, self.issues(), commit["commit"])
            lane["artifact"] = {**commit, "issue": key, "generation": lane["generation"], "description_sha256": lane["description_sha256"],
                "contract_sha256": contract_digest(lane["contract"]), "actors": {r: self.c[r] for r in ROLES}}
            self.save(lane)  # Published before native workflow starts the next role.
            checkout_path = Path(lane.get("published_checkout", workdir))
        else:
            registered_path = lane.get("checkouts", {}).get(role)
            if not registered_path:
                raise Hold("materialize the exact artifact first")
            checkout_path = Path(registered_path)
            if not checkout_path.is_dir():
                raise Hold("materialize the exact artifact first")
        root = self.checks(lane, role, checkout_path)
        artifact = lane["artifact"]
        receipt = {**note, **{k: artifact[k] for k in ("issue", "commit", "tree", "generation", "contract_sha256", "description_sha256")},
                   "role": role, "actor_id": actor, "run_id": run, "dirty": False}
        lane.setdefault("receipts", {})[role] = receipt
        self.save(lane)
        gaps = list(note.get("gaps", [])) + list(note.get("decisions", []))
        if any(json.loads(p.read_text()).get("assertion_passed") is not True for p in (root / "checks").glob("*.json")):
            gaps.append("one or more controller-executed checks failed")
        target = self.c["review_status"] if role == "developer" else self.c["qa_status"]
        if role == "reviewer" and note.get("complete_contract_review") is not True:
            gaps.append("full original contract coverage not independently approved")
        if role == "qa" and not gaps:
            try:
                decision = validate_completion(lane["contract"], artifact, lane["receipts"]["developer"], lane["receipts"]["reviewer"], receipt, root)
            except (AcceptanceError, KeyError) as e:
                gaps.append(str(e))
            else:
                lane["completion_decision"] = decision
                target = "done"
        if gaps:
            target = "in_review"
        receipt["gaps"] = gaps
        output = root / "handoff.json"
        write_json(output, {"outcome": note.get("outcome", ""), "evidence": receipt, "gaps": gaps,
            "choices": "Automatic engineering artifact acceptance; no merge or deployment." if target == "done" else "Resolve gaps on original ticket; no criteria waived.", "next_status": target})
        self.transition(lane, issue, target, output)
        lane["phase"] = "done" if target == "done" else "held" if gaps else "reviewer" if role == "developer" else "qa"
        self.save(lane)
        return {"issue": key, "status": target, "gaps": gaps, "artifact": artifact}



if __name__ == '__main__':
    raise SystemExit('Use canonical tooling/pipeline/serial.py; the core controller is not a standalone dispatcher.')
