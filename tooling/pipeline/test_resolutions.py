import copy
import json
from pathlib import Path
import unittest

from controller import Hold, requirements, digest
import test_controller as support
from test_controller import DESCRIPTION, item


class ResolutionTests(unittest.TestCase):
    g = support.Tests.g
    setUp = support.Tests.setUp
    tearDown = support.Tests.tearDown

    def prepare(self, key="PIT-1"):
        self.fake.rows = [item(1, "in_review"), item(2), item(3)]
        self.fake.rows[0].update(revision=7, description="Approved clarification\n\n" + DESCRIPTION, assignee_id="human")
        lane = {"issue":key,"id":"id-1","generation":1,"phase":"held","repairs":1,
                "description":DESCRIPTION,"requirements":requirements(DESCRIPTION),
                "description_sha256":"old","receipts":{"developer":{"gap":"decision missing"}}}
        self.ctl.save(lane)
        self.approval = self.repo / ".pipeline-artifact" / "approval.json"
        self.approval.parent.mkdir(exist_ok=True)
        self.approval.write_text(json.dumps({"issue":key,"authority":"Direct human decision", "approvedRules":["Approved clarification"], "description_sha256":digest(self.fake.rows[0]["description"])}))
        return copy.deepcopy(lane)

    def test_resolution_preserves_prior_generation_and_original_criteria_once(self):
        old = self.prepare()
        preview = self.ctl.resolve("PIT-1", self.approval, 1, 7)
        self.assertEqual(preview["generation"], 2)
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.ctl.lanes()["PIT-1"], old)
        out = self.ctl.resolve("PIT-1", self.approval, 1, 7, True)
        self.assertEqual(out["status"], "todo")
        current = self.ctl.lanes()["PIT-1"]
        self.assertEqual(current["repairs"], 1)
        self.assertEqual(current["requirements"], old["requirements"])
        self.assertNotIn("receipts", current)
        archived = json.loads(Path(current["prior_generations"][-1]).read_text())
        self.assertEqual(archived["lane"], old)
        self.assertFalse(any(x[:3] == ["issue", "comment", "add"] for x in self.fake.writes))
        with self.assertRaises(Hold): self.ctl.resolve("PIT-1", self.approval, 1, 7, True)
        self.assertEqual(len([x for x in self.fake.writes if x[:2]==["issue","update"]]),1)
        self.assertEqual((self.repo/"source.txt").read_text(), "base")
        self.assertEqual(self.g("status","--porcelain"), "")

    def test_resolution_refuses_stale_or_changed_original_contract(self):
        for mode in ("revision","generation","criteria","source","approval"):
            with self.subTest(mode=mode):
                self.fake.writes=[];self.prepare()
                generation,revision=1,7
                if mode=="revision":revision=6
                if mode=="generation":generation=2
                if mode=="criteria":self.fake.rows[0]["description"]=DESCRIPTION.replace("must return", "may ignore")
                if mode=="source":self.fake.rows[0]["description"]="different original"
                if mode=="approval":self.approval.write_text('{}')
                with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,generation,revision,True)
                self.assertEqual(self.fake.writes,[])

    def test_resolution_respects_active_runs_slots_and_uncertain_operations(self):
        self.prepare();self.fake.runs["id-1"]=[{"status":"running"}]
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.fake.runs={};self.fake.rows[1]["status"]="todo";self.fake.rows[2]["status"]="todo"
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.fake.rows[1]["status"]="backlog";self.fake.rows[2]["status"]="backlog"
        self.ctl.reserve("previous-uncertain")
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.assertEqual(self.fake.writes,[])

    def preserved_runtime(self):
        old = self.prepare();old["contract"] = {"allowed_paths":["source.txt"]};self.ctl.save(old)
        self.c["workspace"]="workspace"
        branch="agent/synthetic/pit-1";original=self.g("branch","--show-current");base=self.g("rev-parse","HEAD")
        self.g("checkout","-qb",branch);(self.repo/"source.txt").write_text("preserved partial implementation")
        self.g("commit","-qam","native task source checkpoint");commit=self.g("rev-parse","HEAD")
        self.g("checkout",original)
        message="multica: task branch record\n\nMultica-Workspace: workspace\nMultica-Agent: dev\nMultica-Conversation: id-1"
        record=self.g("commit-tree",self.g("rev-parse","HEAD^{tree}"),"-p",base,"-p",commit,"-m",message)
        self.g("update-ref","refs/multica/local-state/"+branch,record)
        self.fake.runs["id-1"]=[{"id":"old-native-run","status":"completed","issue_id":"id-1","agent_id":"dev","result":{"branch_name":branch}}]
        approval=json.loads(self.approval.read_text());approval["preserved_source"]={"commit":commit,"base":base,"run_id":"old-native-run"};self.approval.write_text(json.dumps(approval))
        return branch,base,commit

    def test_explicit_runtime_recovery_preserves_source_without_merging_main(self):
        branch,base,commit=self.preserved_runtime()
        self.assertEqual(self.g("rev-parse","HEAD"),base)
        self.ctl.resolve("PIT-1",self.approval,1,7,True)
        lane=self.ctl.lanes()["PIT-1"]
        self.assertEqual(lane["rework_base_commit"],commit)
        self.assertEqual(lane["preserved_source"]["commit"],commit)
        self.assertEqual(self.g("rev-parse","HEAD"),base)
        self.assertEqual((self.repo/"source.txt").read_text(),"base")
        self.assertEqual(self.g("show",commit+":source.txt"),"preserved partial implementation")

    def test_runtime_recovery_rejects_branch_drift_or_unbound_runtime(self):
        branch,base,commit=self.preserved_runtime()
        self.g("update-ref","refs/heads/"+branch,base)
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.g("update-ref","refs/heads/"+branch,commit)
        self.fake.runs["id-1"][0]["agent_id"]="unrelated"
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.assertEqual(self.fake.writes,[])

    def test_staged_artifact_survives_exact_native_instruction_wrapper(self):
        branch,base,commit=self.preserved_runtime()
        lane=self.ctl.lanes()["PIT-1"];lane["artifact"]={"commit":commit};self.ctl.save(lane)
        original=self.g("branch","--show-current");self.g("checkout",branch)
        (self.repo/"AGENTS.md").write_text("synthetic runtime instructions")
        self.g("add","AGENTS.md");self.g("commit","-qm","runtime wrapper");tip=self.g("rev-parse","HEAD");self.g("checkout",original)
        message="Multica-Workspace: workspace\nMultica-Agent: dev\nMultica-Conversation: id-1"
        record=self.g("commit-tree",self.g("rev-parse","HEAD^{tree}"),"-p",base,"-p",tip,"-m",message)
        self.g("update-ref","refs/multica/local-state/"+branch,record)
        approval=json.loads(self.approval.read_text());approval["preserved_source"]["runtime_tip"]=tip;self.approval.write_text(json.dumps(approval))
        self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.assertEqual(self.ctl.lanes()["PIT-1"]["rework_base_commit"],commit)
        self.assertEqual(self.g("rev-parse","HEAD"),base)

    def test_runtime_wrapper_rejects_unstaged_or_application_changes(self):
        branch,base,commit=self.preserved_runtime()
        original=self.g("branch","--show-current");self.g("checkout",branch)
        (self.repo/"source.txt").write_text("unreviewed application mutation")
        self.g("commit","-qam","mutation");tip=self.g("rev-parse","HEAD");self.g("checkout",original)
        approval=json.loads(self.approval.read_text());approval["preserved_source"]["runtime_tip"]=tip;self.approval.write_text(json.dumps(approval))
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        lane=self.ctl.lanes()["PIT-1"];lane["artifact"]={"commit":commit};self.ctl.save(lane)
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.assertEqual(self.fake.writes,[])

    def test_resolution_does_not_retry_uncertain_status_update(self):
        self.prepare();self.fake.fail_update=True
        with self.assertRaises(TimeoutError):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.fake.rows[0]["status"]="in_review"
        with self.assertRaises(Hold):self.ctl.resolve("PIT-1",self.approval,1,7,True)
        self.assertEqual(len([x for x in self.fake.writes if x[:2]==["issue","update"]]),1)
