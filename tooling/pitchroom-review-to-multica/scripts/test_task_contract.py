import copy
import hashlib
from pathlib import Path
import tempfile
import unittest
import sync_review as s
from task_contract import readiness
from test_sync_review import proposal, issue, FakeCLI, REPORT


class ContractTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(dir=Path.cwd())
        self.root = Path(self.tmp.name)
        self.source = self.root / 'owned.py'
        self.source.write_text('def work():\n    return 1\n')
        self.p = proposal()
        self.p.update(schema_version=2, repo_root=str(self.root))
        self.t = self.p['tasks'][0]
        self.t.update(match_issue='PIT-1', task_type='implementation', priority={'value':'high','reason':'Principal task is misleading'}, dependencies=[], deliverable='A selected task', preserve=['Old draft survives'], forbidden_paths=['archive/**'], scope_expansion_rule='Review new files before writing', file_plan_status='bounded', file_map=[{'path':'owned.py','symbol':'def work():','line':1,'sha256':hashlib.sha256(self.source.read_bytes()).hexdigest(),'role':'planned_edit','reason':'Owns selection'}], start_approval={'status':'pending','evidence':''}, completion='Evidence then human review', verification=[{'kind':'deterministic','action':'Verify task behavior','evidence':'Test output'}], open_decisions=[])
        self.t['acceptance'] = [{'case':kind,'kind':'browser','scenario':'switch topic','expected':'preserve ownership'}for kind in ['normal','refusal','failure','recovery']]

    def tearDown(self):
        self.tmp.cleanup()

    def test_nine_sections_and_priority_delta_are_visible(self):
        plan=s.preview(self.p, REPORT, [issue()]);op=plan['payload']['operations'][0]
        self.assertEqual(op['field_changes']['priority'],{'before':'medium','after':'high'})
        self.assertEqual(op['start_gate']['verdict'],'not_ready')
        self.assertEqual(op['description'].count('### '),9)
        self.assertIn('User outcome',op['description'])

    def test_pending_gate_cannot_become_ready_from_backlog(self):
        self.assertEqual(readiness(self.t,[issue()])['verdict'],'not_ready')
        self.t['start_approval']={'status':'approved','evidence':'Actual human approval record'}
        self.assertEqual(readiness(self.t,[issue()])['verdict'],'ready_for_reviewed_execution')
        self.t['file_plan_status']='partial'
        self.assertEqual(readiness(self.t,[issue()])['verdict'],'not_ready')

    def test_dependency_status_alone_does_not_prove_acceptance(self):
        self.t['start_approval']={'status':'approved','evidence':'Approval record'}
        self.t['dependencies']=[{'issue':'PIT-2','kind':'hard','reason':'Needs stable contract','completion_condition':'Accepted contract','accepted_evidence':''}]
        dep={**issue(),'identifier':'PIT-2','id':'two','status':'done'}
        self.assertEqual(readiness(self.t,[dep])['verdict'],'not_ready')
        self.t['dependencies'][0]['accepted_evidence']='Human accepted contract receipt'
        self.assertEqual(readiness(self.t,[dep])['verdict'],'ready_for_reviewed_execution')

    def test_recommended_and_parallel_are_not_hard_gates(self):
        self.t['start_approval']={'status':'approved','evidence':'Approval record'}
        for kind in ['recommended','parallel']:
            self.t['dependencies']=[{'issue':'PIT-2','kind':kind,'reason':'Business order','completion_condition':'Helpful context'}]
            self.assertEqual(readiness(self.t,[])['verdict'],'ready_for_reviewed_execution')

    def test_planning_and_index_are_not_implementation_ready(self):
        for kind in ['planning','coordination']:
            self.t['task_type']=kind
            self.assertEqual(readiness(self.t,[])['verdict'],'not_implementation')

    def test_source_receipt_drift_and_fabricated_symbol_are_rejected(self):
        self.source.write_text('def changed():\n    return 2\n')
        with self.assertRaisesRegex(ValueError,'Mapped source changed'):
            s.preview(self.p,REPORT,[issue()])
        self.t['file_map'][0]['sha256']=hashlib.sha256(self.source.read_bytes()).hexdigest()
        with self.assertRaisesRegex(ValueError,'symbol/line'):
            s.preview(self.p,REPORT,[issue()])

    def test_mapped_paths_cannot_escape_or_overlap_protection(self):
        for path in ['../escape.py','.env.local']:
            bad=copy.deepcopy(self.p);bad['tasks'][0]['file_map'][0]['path']=path
            with self.assertRaisesRegex(ValueError,'safe repository'):
                s.preview(bad,REPORT,[issue()])
        self.t['forbidden_paths']=['owned.py']
        with self.assertRaisesRegex(ValueError,'protected path'):
            s.preview(self.p,REPORT,[issue()])

    def test_missing_failure_case_is_not_a_complete_contract(self):
        self.t['acceptance'].pop()
        with self.assertRaisesRegex(ValueError,'normal, refusal, failure and recovery'):
            s.preview(self.p,REPORT,[issue()])

    def test_hard_cycles_and_unknown_external_issues_are_rejected(self):
        self.t['dependencies']=[{'issue':'PIT-1','kind':'hard','reason':'bad self dependency','completion_condition':'output'}]
        with self.assertRaisesRegex(ValueError,'cycle'):
            s.preview(self.p,REPORT,[issue()])
        self.t['dependencies'][0]['issue']='PIT-999'
        with self.assertRaisesRegex(ValueError,'unavailable'):
            s.preview(self.p,REPORT,[issue()])

    def test_fake_apply_changes_only_reviewed_priority_and_description(self):
        cli=FakeCLI([issue()]);plan=s.preview(self.p,REPORT,cli.issues());old=s.snapshot(cli.get('one'))
        s.apply(plan,plan['sha256'],REPORT,cli,self.root/'journal.json')
        after=s.snapshot(cli.get('one'))
        self.assertEqual(after['priority'],'high')
        self.assertEqual({k:v for k,v in after.items()if k not in ['description','priority']},{k:v for k,v in old.items()if k not in ['description','priority']})
        self.assertIn('--no-start',cli.writes[0])
        self.assertEqual(s.preview(self.p,REPORT,cli.issues())['payload']['operations'][0]['kind'],'unchanged')


if __name__=='__main__':
    unittest.main()
