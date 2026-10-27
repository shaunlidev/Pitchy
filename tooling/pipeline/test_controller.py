import contextlib
import copy
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from controller import Controller, Hold, requirements, lock, digest


DESCRIPTION = "### 7. Observable acceptance\n- [ ] normal / deterministic. source must return its issue-specific value.\n### 8. Verification\n"


def item(number, status="backlog", deps=None):
    return {"id": "id-" + str(number), "identifier": "PIT-" + str(number), "number": number,
            "project_id": "project", "status": status, "assignee_id": None, "description": DESCRIPTION,
            "metadata": {"automation_mode": "dependency_queue", "depends_on": json.dumps(deps or [])}}


def bound_report(workdir, source):
    path=Path(workdir).resolve()/'.pipeline-artifact/role-report.json'
    path.parent.mkdir(parents=True,exist_ok=True)
    path.write_bytes(Path(source).read_bytes())
    return path


class Fake:
    def __init__(self, rows, config):
        self.rows, self.c, self.writes = rows, config, []
        self.fail_update = False
        self.runs = {}

    def __call__(self, args):
        if args[:2] == ["issue", "list"]:
            return {"issues": copy.deepcopy(self.rows), "has_more": False}
        if args[:2] == ["issue", "runs"]:
            return self.runs.get(args[2], [])
        self.writes.append(args)
        if args[:3] == ["issue", "comment", "add"]:
            return {}
        row = next(x for x in self.rows if x["id"] == args[2])
        if args[1] == "assign":
            assert "--no-start" in args
            row["assignee_id"] = args[args.index("--to-id") + 1]
        else:
            row["status"] = args[args.index("--status") + 1]
            handlers = {"todo": "developer", "started_2": "reviewer", "started_3": "qa"}
            if row["status"] in handlers:
                row["assignee_id"] = self.c[handlers[row["status"]]]
            if self.fail_update:
                raise TimeoutError("server applied update but response lost")
        return {}


class Tests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.g("init", "-q")
        self.g("config", "user.name", "Synthetic QA")
        self.g("config", "user.email", "qa@example.invalid")
        (self.repo / ".gitignore").write_text(".pipeline-artifact/\n.pipeline-handoff-*.json\nnode_modules/\n")
        (self.repo / "source.txt").write_text("base")
        (self.repo / "check.py").write_text('import json;from pathlib import Path;print(json.dumps({"passed":Path("source.txt").read_text()=="lane1"}))\n')
        self.g("add", "."); self.g("commit", "-qm", "synthetic baseline")
        dependency = self.repo / "node_modules" / "synthetic"
        dependency.mkdir(parents=True)
        (dependency / "package.json").write_text('{"name":"synthetic"}')
        self.c = {"project": "project", "repository": str(self.repo), "developer": "dev", "reviewer": "review", "qa": "qa", "max_lanes": 2, "review_status": "started_2", "qa_status": "started_3"}
        self.fake = Fake([item(1), item(2), item(3)], self.c)
        self.ctl = Controller(self.c, self.fake, self.root / "state")
        (self.root/"state/evidence-budget.json").write_text(json.dumps({"cap_bytes":320000000,"accounted_bytes":300000000,"allocation_bytes":20000000,"accounting_sha256":"a"*64}))

    def tearDown(self):
        self.ctl.close(); self.tmp.cleanup()

    def g(self, *args):
        return subprocess.check_output(["git", "-C", str(self.repo), *args], stderr=subprocess.DEVNULL, text=True).strip()

    @contextlib.contextmanager
    def runtime(self, role, root, run=None):
        run = run or role + "-run"
        self.fake.runs["id-1"] = [{"id": run, "issue_id": "id-1", "agent_id": self.c[role], "status": "running", "work_dir": str(root)}]
        before = Path.cwd()
        os.chdir(root)
        try:
            with patch.dict(os.environ, MULTICA_AGENT_ID=self.c[role], MULTICA_TASK_ID=run):
                yield
        finally:
            os.chdir(before)

    def test_dispatch_two_then_repeated_poll_no_duplicate(self):
        self.assertEqual(self.ctl.dispatch(True)["started"], ["PIT-1", "PIT-2"])
        self.assertEqual(self.ctl.dispatch(True)["started"], [])
        self.assertEqual(len([x for x in self.fake.writes if x[:2] == ["issue", "update"]]), 2)

    def test_dry_run_no_remote_mutations(self):
        self.assertEqual(self.ctl.dispatch()["candidates"], ["PIT-1", "PIT-2"])
        self.assertEqual(self.fake.writes, [])

    def test_dependency_in_review_cancelled_missing_does_not_start(self):
        for status in ("in_review", "cancelled", "backlog"):
            self.fake.rows = [item(1, deps=["PIT-2"]), item(2, status)]
            self.assertIn("PIT-1", self.ctl.dispatch()["held"])
        self.fake.rows = [item(1, deps=["PIT-99"])]
        self.assertEqual(self.ctl.dispatch()["candidates"] if "candidates" in self.ctl.dispatch() else [], [])

    def test_done_dependency_without_artifact_is_held(self):
        self.fake.rows = [item(1, deps=["PIT-2"]), item(2, "done")]
        self.assertIn("artifact unavailable", self.ctl.dispatch()["held"]["PIT-1"])

    def test_unmerged_dependency_is_not_silently_consumed(self):
        self.g("checkout", "-qb", "prerequisite")
        (self.repo / "source.txt").write_text("accepted dependency")
        self.g("commit", "-qam", "accepted dependency")
        sha = self.g("rev-parse", "HEAD")
        self.g("checkout", "-")
        self.ctl.save({"issue": "PIT-2", "artifact": {"commit": sha}})
        self.fake.rows = [item(1, deps=["PIT-2"]), item(2, "done")]
        self.assertIn("not integrated", self.ctl.dispatch()["held"]["PIT-1"])

    def test_uncertain_timeout_never_repeats_update(self):
        self.fake.fail_update = True
        with self.assertRaises(TimeoutError): self.ctl.dispatch(True)
        self.fake.rows[0]["status"] = "backlog"
        with self.assertRaises(Hold): self.ctl.dispatch(True)
        self.assertEqual(len([x for x in self.fake.writes if x[:2] == ["issue", "update"]]), 1)

    def test_missing_acceptance_inventory_is_held(self):
        self.fake.rows = [item(1)]; self.fake.rows[0]["description"] = "do something"
        self.assertIn("contract clarification", self.ctl.dispatch()["held"]["PIT-1"])

    def test_chinese_contract_freezes_all_four_original_scenarios(self):
        rows = requirements("## 7. 验收草案\n正常：observable outcome\n拒绝：preserve state\n失败：retain failure\n恢复：restore version\n## 8. 验证与未决\nNot an extra criterion")
        self.assertEqual([x["text"] for x in rows], ["正常：observable outcome", "拒绝：preserve state", "失败：retain failure", "恢复：restore version"])

    def test_rework_checks_native_and_public_ancestry_separately(self):
        baseline = self.g("rev-parse", "HEAD")
        self.g("checkout", "-qb", "native-history")
        (self.repo / "native-only.txt").write_text("private runtime history")
        self.g("add", "native-only.txt"); self.g("commit", "-qm", "native prior")
        native_prior = self.g("rev-parse", "HEAD")
        (self.repo / "source.txt").write_text("native repaired")
        self.g("commit", "-qam", "native repair")
        native_fixed = self.g("rev-parse", "HEAD")
        self.g("checkout", "-qb", "public-history", baseline)
        (self.repo / "source.txt").write_text("public prior")
        self.g("commit", "-qam", "public prior")
        public_prior = self.g("rev-parse", "HEAD")
        (self.repo / "source.txt").write_text("public repaired")
        self.g("commit", "-qam", "public repair")
        public_fixed = self.g("rev-parse", "HEAD")
        row = self.fake.rows[0]
        original = {"issue": "PIT-1", "id": "id-1", "generation": 2,
                    "description_sha256": digest(row["description"]),
                    "rework_base_commit": native_prior,
                    "rework_public_commit": public_prior}
        for role in ("reviewer", "qa"):
            row.update(status=self.c["review_status" if role == "reviewer" else "qa_status"],
                       assignee_id=self.c[role])
            lane = {**original, "phase": role, "artifact": {"commit": public_fixed}}
            self.ctl.save(lane)
            with self.runtime(role, self.repo):
                self.ctl.current("PIT-1", role)
                lane["artifact"] = {"commit": native_fixed}
                self.ctl.save(lane)
                with self.assertRaisesRegex(Hold, "prior delivery"):
                    self.ctl.current("PIT-1", role)
                lane.pop("rework_public_commit")
                self.ctl.save(lane)
                self.ctl.current("PIT-1", role)
                lane["artifact"] = {"commit": public_fixed}
                self.ctl.save(lane)
                with self.assertRaisesRegex(Hold, "prior delivery"):
                    self.ctl.current("PIT-1", role)
        row.update(status="in_progress", assignee_id=self.c["developer"])
        self.ctl.save({**original, "phase": "developer"})
        self.g("checkout", "native-history")
        with self.runtime("developer", self.repo):
            self.ctl.current("PIT-1", "developer")
            self.g("checkout", "public-history")
            with self.assertRaisesRegex(Hold, "prior delivery"):
                self.ctl.current("PIT-1", "developer")

    def test_runtime_identity_required(self):
        self.ctl.dispatch(True)
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(Hold): self.ctl.current("PIT-1", "developer")

    def test_wrong_ticket_run_and_workspace_are_rejected(self):
        self.ctl.dispatch(True)
        with patch.dict(os.environ, MULTICA_AGENT_ID="dev", MULTICA_TASK_ID="unrelated"):
            with self.assertRaisesRegex(Hold, "active run"):
                self.ctl.current("PIT-1", "developer")
        with self.runtime("developer", self.repo):
            os.chdir(self.root)
            with self.assertRaisesRegex(Hold, "actual native"):
                self.ctl.current("PIT-1", "developer")

    def test_negative_or_missing_engineering_classification_is_held(self):
        self.ctl.dispatch(True)
        for value in (False, None):
            path = self.root / "invalid-plan.json"
            path.write_text(json.dumps({"engineering": value}))
            with self.runtime("developer", self.repo):
                with self.assertRaisesRegex(Hold, "classification"):
                    self.ctl.plan("PIT-1", path)

    def test_dependency_mutation_is_detected(self):
        from artifacts import prepare_dependencies, verify_dependencies, ArtifactError
        native = self.root / "isolated"
        self.g("worktree", "add", "--detach", str(native))
        manifest = prepare_dependencies(self.repo, native)
        self.assertTrue(verify_dependencies(native, manifest))
        (native / "node_modules/synthetic/package.json").write_text("changed")
        with self.assertRaisesRegex(ArtifactError, "identity changed"):
            verify_dependencies(native, manifest)

    def test_cross_process_lock_rejects_second_controller(self):
        with lock(self.root / "lock-state"):
            proc = subprocess.run(["python3", "-c", "from pathlib import Path;from controller import lock,Hold;import sys;\ntry:\n with lock(Path(sys.argv[1])): pass\nexcept Hold: sys.exit(7)", str(self.root / "lock-state")], cwd=Path(__file__).parent, capture_output=True)
            self.assertEqual(proc.returncode, 7, proc.stderr)

    def test_independent_issue_locks_do_not_block_each_other(self):
        with lock(self.root / "parallel", name="issue-PIT-1"):
            with lock(self.root / "parallel", name="issue-PIT-2"):
                with lock(self.root / "parallel", name="controller"):
                    pass
            with self.assertRaises(Hold):
                with lock(self.root / "parallel", name="issue-PIT-1"):
                    pass

    def test_runtime_checkpoint_preserves_original_instructions_and_root(self):
        from artifacts import checkpoint_runtime_metadata, ArtifactError
        (self.repo / "AGENTS.md").write_text("Original instructions.\n")
        self.g("add", "AGENTS.md"); self.g("commit", "-qm", "instructions")
        root_before = self.g("rev-parse", "HEAD")
        native = self.root / "runtime"
        self.g("worktree", "add", "--detach", str(native))
        block = "\n<!-- BEGIN MULTICA-RUNTIME (auto-managed; do not edit) -->\nRuntime identity\n<!-- END MULTICA-RUNTIME -->\n"
        (native / "AGENTS.md").write_text("Original instructions.\n" + block)
        self.assertIsNotNone(checkpoint_runtime_metadata(native, "PIT-1", 1, repository=self.repo))
        self.assertEqual(self.g("rev-parse", "HEAD"), root_before)
        self.assertEqual((self.repo / "AGENTS.md").read_text(), "Original instructions.\n")
        (native / "AGENTS.md").write_text("Weakened instructions.\n" + block)
        with self.assertRaisesRegex(ArtifactError, "beyond managed"):
            checkpoint_runtime_metadata(native, "PIT-1", 1, repository=self.repo)

    def test_stale_native_base_cannot_consume_done_dependency(self):
        native = self.root / "old-native"
        self.g("worktree", "add", "--detach", str(native))
        (self.repo / "source.txt").write_text("new accepted dependency")
        self.g("commit", "-qam", "dependency")
        dependency = self.g("rev-parse", "HEAD")
        self.c["legacy_dependencies"] = {"PIT-2": dependency}
        self.fake.rows = [item(1, deps=["PIT-2"]), item(2, "done")]
        self.ctl.dispatch(True)
        with self.runtime("developer", native):
            with self.assertRaisesRegex(Hold, "not integrated"):
                self.ctl.workspace("PIT-1", native)

    def test_stale_status_cannot_advance(self):
        self.ctl.dispatch(True)
        self.fake.rows[0]["status"] = "blocked"
        with self.runtime("developer", self.repo):
            with self.assertRaisesRegex(Hold, "current workflow"):
                self.ctl.current("PIT-1", "developer")

    def test_exact_artifact_dev_review_qa_auto_done_without_merging(self):
        main_before = self.g("rev-parse", "HEAD")
        self.fake.rows = [item(1)]
        self.ctl.dispatch(True)
        native = self.root / "dev"
        self.g("worktree", "add", "-qb", "dev-task", str(native))
        (native / "source.txt").write_text("lane1")
        criterion = {**requirements(DESCRIPTION)[0], "kind": "engineering", "required": True, "check_ids": ["normal"]}
        plan = {"engineering": True, "decisions": [], "criteria": [criterion], "checks": {"normal": {"argv": ["python3", "check.py"], "cwd": ".", "proof": {"kind": "json", "pointer": "/passed", "equals": True}}}, "allowed_paths": ["source.txt", "check.py"]}
        plan_path = self.root / "plan.json"; plan_path.write_text(json.dumps(plan))
        report_path = self.root / "report.json"
        report = {"outcome": "source returns lane1", "gaps": [], "decisions": [], "criterion_results": [{"id": "AC-1", "status": "pass"}]}
        report_path.write_text(json.dumps(report))
        with self.runtime("developer", native, "dev-run"):
            self.ctl.workspace("PIT-1", native)
            self.ctl.plan("PIT-1", plan_path)
            self.assertEqual(self.ctl.stage("PIT-1", "developer", bound_report(native,report_path), native)["status"], "started_2")
        commit = self.ctl.lanes()["PIT-1"]["artifact"]["commit"]
        for role, actor in (("reviewer", "review"), ("qa", "qa")):
            root = self.root / role
            self.g("worktree", "add", "--detach", str(root), main_before)
            native_before = subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip()
            with self.runtime(role, root):
                checkout = self.ctl.checkout("PIT-1", role, root)
                self.assertEqual(subprocess.check_output(["git", "-C", checkout["checkout"], "rev-parse", "HEAD"], text=True).strip(), commit)
                report_path.write_text(json.dumps({**report, "complete_contract_review": True}))
                output = self.ctl.stage("PIT-1", role, bound_report(root,report_path), root)
            self.assertEqual(subprocess.check_output(["git", "-C", str(root), "rev-parse", "HEAD"], text=True).strip(), native_before)
        self.assertEqual(output["status"], "done")
        self.assertEqual(self.g("rev-parse", "HEAD"), main_before)
        self.assertEqual((self.repo / "source.txt").read_text(), "base")
        done = [x for x in self.fake.writes if x[:2] == ["issue", "update"] and "done" in x]
        self.assertEqual(len(done), 1)
        self.assertIn("--no-start", done[0])


class RegisteredProductPrerequisite(unittest.TestCase):
    def test_pit25_consumes_only_the_accepted_integrated_pit24_delivery(self):
        from artifacts import has_ancestor
        source=Path(__file__).resolve().parents[2]
        config=json.loads((source/'tooling/pipeline/runtime.json').read_text())
        accepted=config['legacy_dependencies']['PIT-24']
        self.assertEqual(accepted,'061895deca069bf63fd9d40c2e1451b1b97e1fbc')
        self.assertTrue(has_ancestor(source,'8a2cd7a8837b782ac6f1dd3e8d7ea56ae1897579',accepted))
        head=subprocess.check_output(['git','-C',str(source),'rev-parse','HEAD'],text=True).strip()
        old_base=subprocess.check_output(['git','-C',str(source),'rev-parse',accepted+'^1'],text=True).strip()
        config['repository']=str(source)
        calls=[]
        with tempfile.TemporaryDirectory(prefix='pit25-prerequisite-check-') as folder:
            controller=Controller(config,lambda args:calls.append(args),Path(folder)/'isolated-state')
            target={'identifier':'PIT-25','metadata':{'depends_on':'["PIT-24"]'}}
            prior={'identifier':'PIT-24','status':'done'}
            try:
                controller.dependencies(target,[target,prior],base=head)
                with self.assertRaisesRegex(Hold,'not integrated'):
                    controller.dependencies(target,[target,prior],base=old_base)
                with self.assertRaisesRegex(Hold,'unaccepted prerequisite'):
                    controller.dependencies(target,[target,{**prior,'status':'in_review'}],base=head)
                saved=config['legacy_dependencies'].pop('PIT-24')
                with self.assertRaisesRegex(Hold,'artifact unavailable'):
                    controller.dependencies(target,[target,prior],base=head)
                config['legacy_dependencies']['PIT-24']=saved
            finally:
                controller.close()
        self.assertEqual(calls,[])


if __name__ == "__main__":
    unittest.main()

class DurableRoleEvidence(unittest.TestCase):
    setUp=Tests.setUp
    tearDown=Tests.tearDown
    g=Tests.g

    def prepare(self, run='review-run', role='reviewer', outcome='pass'):
        self.local=self.repo/'.pipeline-local';self.local.mkdir(exist_ok=True)
        self.probe=self.local/'probe.py';self.probe.write_text('print("independent check")')
        self.raw=self.local/'output.log';self.raw.write_text('actual result: '+outcome)
        self.report=self.local/'report.json'
        self.report.write_text(json.dumps({'outcome':outcome,'evidence_files':['.pipeline-local/probe.py','.pipeline-local/output.log']}))
        self.lane={'issue':'PIT-1','generation':3,'description_sha256':'description',
                   'artifact':{'commit':self.g('rev-parse','HEAD'),'contract_sha256':'contract'}}
        self.role,self.run=role,run

    def retain(self):
        return Path(self.ctl.retain_role_evidence(self.lane,self.role,self.report,self.repo,self.c[self.role],self.run))

    def test_declared_evidence_survives_source_cleanup_with_bound_hashes(self):
        self.prepare();manifest=self.retain();data=json.loads(manifest.read_text())
        import shutil
        shutil.rmtree(self.local)
        verified=self.ctl.verify_role_evidence(manifest.parent,data['binding'])
        self.assertEqual(verified['binding']['run_id'],'review-run')
        self.assertEqual(len(verified['files']),3)
        self.assertEqual((manifest.parent/'files/.pipeline-local/output.log').read_text(),'actual result: pass')
        self.assertLessEqual(sum(p.stat().st_size for p in manifest.parent.rglob('*') if p.is_file()),verified['reserved_bytes'])

    def test_failure_success_and_roles_are_separate_never_overwritten(self):
        self.prepare(run='failure',outcome='fail');first=self.retain();original=first.read_bytes()
        with self.assertRaises(Hold):self.retain()
        self.prepare(run='success',role='qa');second=self.retain()
        self.assertNotEqual(first,second);self.assertEqual(first.read_bytes(),original)
        self.assertEqual(json.loads((first.parent/'report.json').read_text())['outcome'],'fail')

    def test_missing_symlink_escape_and_malformed_declarations_refuse(self):
        self.prepare();outside=self.root/'private';outside.write_text('must not be copied')
        (self.local/'link').symlink_to(outside)
        for name in ['../private',str(outside),'.pipeline-local/missing','.pipeline-local/link']:
            self.report.write_text(json.dumps({'evidence_files':[name]}))
            with self.subTest(name=name):
                with self.assertRaises(Hold):self.retain()
        for names in [{},[{}],['.pipeline-local/probe.py','.pipeline-local/probe.py']]:
            self.report.write_text(json.dumps({'evidence_files':names}))
            with self.assertRaises(Hold):self.retain()
        self.assertFalse((self.ctl.root/'role-evidence').exists())

    def test_corruption_wrong_identity_and_partial_copy_never_verify(self):
        self.prepare();manifest=self.retain();data=json.loads(manifest.read_text())
        with self.assertRaises(Hold):self.ctl.verify_role_evidence(manifest.parent,{**data['binding'],'role':'qa'})
        (manifest.parent/'files/.pipeline-local/output.log').write_text('tampered')
        with self.assertRaises(Hold):self.ctl.verify_role_evidence(manifest.parent,data['binding'])
        manifest.unlink()
        with self.assertRaises(Hold):self.ctl.verify_role_evidence(manifest.parent,data['binding'])
        with self.assertRaises(Hold):self.retain()

    def test_budget_cap_and_deleted_output_do_not_refund(self):
        self.prepare()
        grant=self.ctl.root/'evidence-budget.json';original=grant.read_text()
        value=json.loads(original);value['allocation_bytes']=320000000;grant.write_text(json.dumps(value))
        with self.assertRaises(Hold):self.retain()
        value['allocation_bytes']=1;grant.write_text(json.dumps(value))
        with self.assertRaises(Hold):self.retain()
        grant.write_text(original);manifest=self.retain()
        before=(self.ctl.root/'evidence-reservations.json').read_bytes()
        import shutil
        shutil.rmtree(manifest.parent)
        with self.assertRaises(Hold):self.retain()
        self.assertEqual((self.ctl.root/'evidence-reservations.json').read_bytes(),before)

    def test_copy_interruption_keeps_intent_reservation_and_partial_files(self):
        self.prepare();original=Path.open
        def opened(path,*args,**kwargs):
            if str(path).endswith('files/.pipeline-local/output.log') and args and args[0]=='xb':
                raise OSError('synthetic copy interruption')
            return original(path,*args,**kwargs)
        with patch.object(Path,'open',opened):
            with self.assertRaises(OSError):self.retain()
        target=self.ctl.root/'role-evidence/PIT-1/3/reviewer/review-run'
        self.assertTrue((target/'intent.json').exists())
        self.assertTrue((target/'report.json').exists())
        self.assertFalse((target/'manifest.json').exists())
        with self.assertRaises(Hold):self.retain()

    def test_report_outside_workspace_or_through_parent_symlink_is_refused(self):
        self.prepare();original=self.report
        outside=self.root/'outside-report.json';outside.write_text(original.read_text())
        self.report=outside
        with self.assertRaisesRegex(Hold,'inside'):self.retain()
        linked=self.local/'linked-parent';linked.symlink_to(self.local,target_is_directory=True)
        self.report=linked/'report.json'
        with self.assertRaisesRegex(Hold,'symlink'):self.retain()
        self.assertFalse((self.ctl.root/'role-evidence').exists())
        self.assertFalse((self.ctl.root/'evidence-reservations.json').exists())
        self.report=original;self.assertTrue(self.retain().is_file())
