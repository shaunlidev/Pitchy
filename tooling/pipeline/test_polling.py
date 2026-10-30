import copy
import os
import controller
import json
from pathlib import Path
import subprocess
import unittest
import time
from unittest.mock import patch

import github_sync as gs
import serial
import test_controller as core

SHA='a'*40
POLICY={'repository':'owner/repo','project_id':'project','merge_policy':'human_approved_squash','dispatch_control_default':'open'}


def issue(n=1):
    x=core.item(n);x['metadata']['artifact_sha']='original';return x


def pr(n=1,key='PIT-1'):
    return {'number':n,'title':key+': change','head':{'sha':SHA,'ref':'codex/'+key.lower()+'-change','repo':{'full_name':'owner/repo'}},'base':{'ref':'main','repo':{'full_name':'owner/repo'}},'state':'open','draft':True,'merged_at':None}


class Memory:
    def __init__(self,rows):self.rows=rows;self.writes=[]
    def __call__(self,a):
        if a[:2]==['issue','list']:
            offset=int(a[a.index('--offset')+1]);return {'issues':copy.deepcopy(self.rows[offset:offset+100]),'has_more':offset+100<len(self.rows)}
        if a[:3]==['issue','metadata','set']:
            self.writes.append(a);row=next(x for x in self.rows if x['id']==a[3]);row['metadata'][a[a.index('--key')+1]]=a[a.index('--value')+1];return {}
        raise AssertionError(a)


class GH:
    def __init__(self,rows):self.rows=rows;self.fail=False
    def prs(self):
        if self.fail:raise gs.SyncError('offline')
        return self.rows
    def snapshot(self,p):return {'number':p['number'],'head':p['head']['sha'],'state':'DRAFT','ci':{'state':'pending'}}


class Polling(unittest.TestCase):
    def test_issue_pagination_and_duplicate_refusal(self):
        rows=[issue(i) for i in range(101)];self.assertEqual(len(gs.all_issues(Memory(rows),'project')),101)
        rows[-1]=rows[0]
        with self.assertRaises(gs.SyncError):gs.all_issues(Memory(rows),'project')

    def test_precise_issue_matching_and_explicit_existing_pr(self):
        a,b=issue(1),issue(10);m=gs.mapping([a,b],[pr(key='PIT-10')],'owner/repo');self.assertNotIn('PIT-1',m);self.assertEqual(len(m['PIT-10']),1)
        a['metadata'].update(pr_number=2,pr_url='https://github.com/owner/repo/pull/2')
        self.assertIn('PIT-1',gs.mapping([a],[pr(n=2,key='OTHER-2')],'owner/repo'))

    def test_no_repeated_unchanged_writes_and_no_owned_field_overwrite(self):
        call=Memory([issue()]);gh=GH([pr()]);gs.sync(POLICY,call,gh,True,'t1');first=len(call.writes)
        gs.sync(POLICY,call,gh,True,'t2');self.assertEqual(len(call.writes)-first,1)
        count=len(call.writes);gs.sync(POLICY,call,gh,True,'t2');self.assertEqual(len(call.writes),count)
        self.assertEqual(call.rows[0]['metadata']['artifact_sha'],'original');self.assertEqual(call.rows[0]['metadata']['github_sync_state'],'fresh')
        gh.rows[0]['head']['sha']='b'*40;gs.sync(POLICY,call,gh,True,'t3');self.assertNotEqual(len(call.writes)-first,2)
        self.assertTrue(all(a[:3]==['issue','metadata','set'] for a in call.writes))

    def test_failure_marks_old_snapshot_unavailable(self):
        call=Memory([issue()]);gh=GH([pr()]);gs.sync(POLICY,call,gh,True);gh.fail=True
        with self.assertRaises(gs.SyncError):gs.sync(POLICY,call,gh,True)
        self.assertEqual(call.rows[0]['metadata']['github_sync_state'],'unavailable')

    def test_partial_metadata_write_converges_to_fresh(self):
        call=Memory([issue()]);gh=GH([pr()]);gs.sync(POLICY,call,gh,True,'t1')
        call.rows[0]['metadata']['github_sync_state']='updating'
        gs.sync(POLICY,call,gh,True,'t2');self.assertEqual(call.rows[0]['metadata']['github_sync_state'],'fresh')

    def test_new_publication_failure_invalidates_earlier_fresh_issue(self):
        memory=Memory([issue(1),issue(2)]);gh=GH([pr(1,'PIT-1'),pr(2,'PIT-2')])
        def call(args):
            if args[:3]==['issue','metadata','set'] and args[3]=='id-2' and args[args.index('--key')+1]=='github_prs':raise gs.SyncError('second publication failed')
            return memory(args)
        with self.assertRaises(gs.SyncError):gs.sync(POLICY,call,gh,True)
        self.assertEqual([i['metadata']['github_sync_state'] for i in memory.rows],['unavailable','unavailable'])

    def test_issue_list_failure_invalidates_known_previous_snapshot(self):
        memory=Memory([issue()]);gh=GH([pr()]);gs.sync(POLICY,memory,gh,True)
        def call(args):
            if args[:2]==['issue','list']:raise gs.SyncError('list unavailable')
            return memory(args)
        with self.assertRaises(gs.SyncError):gs.sync(POLICY,call,gh,True)
        self.assertEqual(memory.rows[0]['metadata']['github_sync_state'],'unavailable')

    def test_expiry_during_metadata_writes_never_returns_success(self):
        clock=[0];memory=Memory([issue()]);gh=GH([pr()])
        def call(args):
            value=memory(args)
            if args[:3]==['issue','metadata','set']:clock[0]+=20
            return value
        with patch.object(gs.time,'monotonic',side_effect=lambda:clock[0]):
            with self.assertRaises(gs.SyncError):gs.sync({**POLICY,'max_observation_seconds':45},call,gh,True)
        self.assertEqual(memory.rows[0]['metadata']['github_sync_state'],'unavailable')

    def test_read_only_sync_has_no_writes(self):
        call=Memory([issue()]);gs.sync(POLICY,call,GH([pr()]));self.assertEqual(call.writes,[])

    def test_pr_move_during_query_fails_closed(self):
        p=pr();g=gs.GitHub('owner/repo');g.ci=lambda *a:{'state':'success'}
        changed=copy.deepcopy(p);changed['head']['sha']='b'*40;g.api=lambda *a:changed
        with self.assertRaises(gs.SyncError):g.snapshot(p)

    def ci(self,runs,jobs=None):
        def execute(a):
            if '/jobs?' in a[2]:return [{'jobs':jobs or [{'name':n,'status':'completed','conclusion':'success'} for n in gs.REQUIRED_JOBS]}]
            return [{'workflow_runs':runs}]
        return gs.GitHub('owner/repo',execute).ci(SHA,'pull_request')

    def workflow_run(self,result='success',number=1,sha=SHA):
        return {'id':number,'head_sha':sha,'event':'pull_request','path':'.github/workflows/pr-ci.yml','run_number':number,'run_attempt':1,'status':'completed','conclusion':result}

    def test_latest_run_and_exact_workflow_head_required(self):
        for result in ['failure','cancelled','skipped','timed_out']:
            self.assertEqual(self.ci([self.workflow_run(),self.workflow_run(result,2)])['state'],result)
        self.assertEqual(self.ci([self.workflow_run(sha='b'*40)])['state'],'missing')
        x=self.workflow_run();x['path']='.github/workflows/unrelated.yml';self.assertEqual(self.ci([x])['state'],'missing')
        self.assertEqual(self.ci([self.workflow_run()])['state'],'success')

    def test_missing_skipped_job_cannot_pass(self):
        self.assertEqual(self.ci([self.workflow_run()],[{'name':'PR gate','status':'completed','conclusion':'success'}])['state'],'incomplete')
        jobs=[{'name':n,'status':'completed','conclusion':'skipped' if n=='Application checks' else 'success'} for n in gs.REQUIRED_JOBS]
        self.assertEqual(self.ci([self.workflow_run()],jobs)['state'],'incomplete')


class SerialBehavior(unittest.TestCase):
    def setUp(self):
        self.f=core.Tests();self.f.setUp();self.f.ctl.close();self.f.g('branch','-M','main')
        self.f.c.update(max_lanes=1,owner='owner')
        self.old_call=self.f.fake
        def call(a):
            if a[:3]==['issue','metadata','set']:self.old_call.writes.append(a);return {}
            if a[:2]==['issue','list']:return {'issues':copy.deepcopy(self.old_call.rows),'has_more':False}
            value=self.old_call(a)
            if a[:2]==['issue','update'] and '--assignee-id' in a:
                next(x for x in self.old_call.rows if x['id']==a[2])['assignee_id']=a[a.index('--assignee-id')+1]
            return value
        self.c=serial.Serial(self.f.c,call,self.f.root/'new-state',GH([]),POLICY);self.f.ctl=self.c
        (self.c.root/'evidence-budget.json').write_text((self.f.root/'state/evidence-budget.json').read_text())

    def tearDown(self):self.f.tearDown()

    def lane(self,target='started_2',terminal='completed',ci='success'):
        row=self.f.fake.rows[0];row.update(status='in_progress',assignee_id='dev')
        lane={'issue':'PIT-1','id':'id-1','phase':'awaiting_role_exit','generation':1,'repairs':0,'description_sha256':serial.digest(row['description']),
              'artifact':{'commit':SHA},'pr_number':1,
              'pending':{'target':target,'role':'developer','run':'dev-run','actor':'dev','issue_status':'in_progress','assignee':'dev','source_description':serial.digest(row['description']),'report':'unused','engineering_verified':False}}
        self.f.fake.runs['id-1']=[{'id':'dev-run','agent_id':'dev','status':terminal}]
        self.c.observation={'deadline_monotonic':time.monotonic()+120,'issues':{'PIT-1':{'prs':[{'number':1,'head':SHA,'state':'DRAFT','base':'main','ci':{'state':ci}}]}}}
        self.c.save(lane);return lane

    def test_merge_approval_requires_operator_exact_head_ready_ci_and_stable_captured_base(self):
        lane=self.lane();lane['phase']='awaiting_merge';self.c.save(lane)
        row=self.c.observation['issues']['PIT-1']['prs'][0];row['state']='OPEN'
        class Remote:
            base='b'*40
            state='success'
            def api(self,path):return {'sha':self.base}
            def ci(self,sha,event):return {'state':self.state}
        remote=Remote();self.c.github=remote
        with self.assertRaisesRegex(serial.Hold,'approved head differs'):
            self.c.record_merge_approval('PIT-1','wrong-head')
        with patch.dict(serial.os.environ,{'MULTICA_TASK_ID':'synthetic-native'}):
            with self.assertRaisesRegex(serial.Hold,'human operator'):
                self.c.record_merge_approval('PIT-1',SHA)
        for key,value in [('state','DRAFT'),('base','other'),('ci',{'state':'pending'})]:
            previous=row[key];row[key]=value
            with self.assertRaises(serial.Hold):self.c.record_merge_approval('PIT-1',SHA)
            row[key]=previous
        remote.state='pending'
        with self.assertRaisesRegex(serial.Hold,'pre-merge main CI'):
            self.c.record_merge_approval('PIT-1',SHA)
        self.assertNotIn('merge_approval',self.c.lanes()['PIT-1'])
        remote.state='success';intent=self.c.record_merge_approval('PIT-1',SHA)
        self.assertEqual(intent['base'],'b'*40)
        self.assertEqual(self.c.record_merge_approval('PIT-1',SHA),intent)
        remote.base='c'*40
        with self.assertRaisesRegex(serial.Hold,'reconciliation'):
            self.c.record_merge_approval('PIT-1',SHA)
        self.assertEqual(self.c.lanes()['PIT-1']['merge_approval'],intent)
        self.assertFalse(self.f.fake.writes)

    def test_waiting_merge_and_ci_occupy_single_lane(self):
        for phase in ['awaiting_merge','awaiting_role_exit','reviewer','qa']:
            self.c.save({'issue':'PIT-1','phase':phase});self.assertEqual(self.c.dispatch(True)['started'],[])
        self.assertEqual(self.f.fake.writes,[])

    def test_handoff_waits_for_runtime_and_ci(self):
        self.lane(terminal='running');self.c.drain(True);self.assertFalse(self.f.fake.writes)
        self.lane(ci='cancelled');self.c.drain(True);self.assertFalse(self.f.fake.writes)
        self.lane();self.c.drain(True);self.assertEqual(self.c.lanes()['PIT-1']['phase'],'reviewer')
        self.assertFalse(any(a[:3]==['issue','comment','add'] for a in self.f.fake.writes))
        count=len(self.f.fake.writes);self.c.drain(True);self.assertEqual(len(self.f.fake.writes),count)

    def test_next_lane_published_before_remote_worker_can_start(self):
        self.lane();original=self.c.call;observed=[]
        def call(args):
            if args[:2]==['issue','update']:
                observed.append(self.c.lanes()['PIT-1']['phase'])
            return original(args)
        self.c.call=call;self.c.drain(True)
        self.assertEqual(observed,['reviewer'])

    def test_qa_success_goes_to_waiting_merge_not_done(self):
        lane=self.lane(target='in_review');lane['pending']['engineering_verified']=True;self.c.save(lane)
        self.c.drain(True);self.assertEqual(self.c.lanes()['PIT-1']['phase'],'awaiting_merge')
        self.assertFalse(any('--status' in a and a[a.index('--status')+1]=='done' for a in self.f.fake.writes))
        self.c.drain(True);self.assertEqual(self.c.lanes()['PIT-1']['phase'],'awaiting_merge')

    def test_changed_owner_and_head_are_holds(self):
        self.lane();self.f.fake.rows[0]['assignee_id']='other'
        with self.assertRaises(serial.Hold):self.c.drain(True)
        self.lane();self.c.observation['issues']['PIT-1']['prs'][0]['head']='b'*40
        with self.assertRaises(serial.Hold):self.c.drain(True)

    def test_closed_prematurely_merged_or_retargeted_pr_cannot_handoff(self):
        for state,base in [('CLOSED','main'),('MERGED','main'),('DRAFT','other')]:
            self.lane();row=self.c.observation['issues']['PIT-1']['prs'][0];row.update(state=state,base=base)
            with self.assertRaises(serial.Hold):self.c.drain(True)
        self.assertFalse(self.f.fake.writes)

    def test_expired_observation_cannot_start_role(self):
        self.lane();self.c.observation['deadline_monotonic']=0
        with self.assertRaises(serial.Hold):self.c.drain(True)
        self.assertFalse(any(a[:2]==['issue','update'] for a in self.f.fake.writes))

    def test_activation_required_and_uncertain_write_blocks(self):
        with self.assertRaises(serial.Hold):self.c.require_enabled()
        self.c.reserve('synthetic-uncertain')
        with self.assertRaises(serial.Hold):self.c.reserve('another-operation')

    def test_publication_omits_native_runtime_and_retains_canonical(self):
        repo=self.f.repo;(repo/'AGENTS.md').write_text('Original rules\n');self.f.g('add','AGENTS.md');self.f.g('commit','-qm','rules');base=self.f.g('rev-parse','HEAD')
        native=self.f.root/'native';self.f.g('worktree','add','-qb','native-task',str(native))
        (native/'AGENTS.md').write_text('Original rules\n<!-- BEGIN MULTICA-RUNTIME (auto-managed; do not edit) -->\nprivate-runtime\n<!-- END MULTICA-RUNTIME -->\n')
        (native/'source.txt').write_text('lane1')
        from artifacts import prepare_dependencies
        deps=prepare_dependencies(repo,native)
        lane={'issue':'PIT-1','generation':1,'contract':{'allowed_paths':['source.txt']},'dependencies':deps}
        artifact=self.c.publish_checkpoint(lane,native,'PIT-1')
        self.assertEqual(self.f.g('show',artifact['commit']+':AGENTS.md'),'Original rules')
        self.assertEqual(self.f.g('rev-parse',artifact['commit']+'^'),base)
        self.assertEqual(self.f.g('rev-parse','HEAD'),base)
        self.assertIn('private-runtime',(native/'AGENTS.md').read_text())
        self.assertEqual(self.f.g('show',artifact['commit']+':source.txt'),'lane1')


class OptionalRoles(unittest.TestCase):
    def setUp(self):
        self.fixture = SerialBehavior()
        self.fixture.setUp()
        self.f, self.c = self.fixture.f, self.fixture.c
        self.c.c['optional_roles'] = {'small_tasks_enabled': True, 'small_tasks_agent': 'kimi-dev',
                                      'supplemental_enabled': True, 'supplemental_agent': 'kimi-review'}
        self.f.fake.rows = [core.item(1)]
        self.row = self.f.fake.rows[0]
        old = self.c.call
        def call(args):
            result = old(args)
            if args[:2] == ['issue', 'update'] and '--assignee-id' in args:
                self.row['assignee_id'] = args[args.index('--assignee-id') + 1]
            return result
        self.c.call = call
        self.c.observation = {'deadline_monotonic': time.monotonic()+120, 'issues': {}}

    def tearDown(self):
        self.fixture.tearDown()

    def admit(self, small=True, supplement=True):
        self.row['metadata'].update(developer_route='small' if small else 'default',
                                    supplemental_review='on' if supplement else 'off')
        # Exercise the actual admission implementation without Serial's unrelated live-main precondition.
        controller.Controller.dispatch(self.c, True)
        return self.c.lanes()['PIT-1']

    def prepared(self):
        lane = self.admit()
        head = self.f.g('rev-parse', 'HEAD')
        contract = {'checks': {'normal': {'argv': ['python3','check.py']}}}
        from acceptance import contract_digest
        lane.update(phase='supplemental', description=self.row['description'], contract=contract,
                    artifact={'commit': head, 'tree': self.f.g('rev-parse', 'HEAD^{tree}'),
                              'contract_sha256': contract_digest(contract), 'description_sha256': lane['description_sha256']},
                    receipts={'developer': {'run_id':'dev-run'}}, pr_number=1)
        # Supply a parent commit for the synthetic public artifact.
        self.f.g('commit', '--allow-empty', '-qm', 'public artifact')
        lane['artifact']['commit'] = self.f.g('rev-parse', 'HEAD')
        root = self.c.root/'evidence/PIT-1/1/developer/dev-run'
        for name, value in {'checks/normal.json':'{"assertion_passed":true}', 'logs/normal.stdout':'{"passed":true}', 'logs/normal.stderr':''}.items():
            path=root/name;path.parent.mkdir(parents=True,exist_ok=True);path.write_text(value)
        local = self.f.repo/'.pipeline-local';local.mkdir(exist_ok=True)
        extra = local/'extra-evidence.txt';extra.write_text('original observation')
        report = local/'developer.json';report.write_text(json.dumps({'evidence_files':['.pipeline-local/extra-evidence.txt']}))
        lane['receipts']['developer']['retained_evidence'] = self.c.retain_role_evidence(lane,'developer',report,self.f.repo,'kimi-dev','dev-run')
        self.c.save(lane)
        self.row.update(status='started_2',assignee_id='kimi-review')
        self.f.fake.runs['id-1']=[{'id':'supp-run','issue_id':'id-1','agent_id':'kimi-review','status':'running','work_dir':str(self.f.repo)}]
        self.c.observation['issues']={'PIT-1':{'prs':[{'number':1,'head':lane['artifact']['commit'],'base':'main','state':'DRAFT','ci':{'state':'success'}}]}}
        return lane

    def runtime(self):
        return patch.dict(os.environ, MULTICA_AGENT_ID='kimi-review', MULTICA_TASK_ID='supp-run')

    def in_repo(self):
        return patch('pathlib.Path.cwd', return_value=self.f.repo)

    def report(self,bundle,**overrides):
        path=self.f.repo/'.pipeline-local/advisory.json';path.parent.mkdir(exist_ok=True)
        path.write_text(json.dumps({'completed':True,'inputs_sha256':bundle['inputs_sha256'],
                                    'gaps':[],'failures':[],'not_run':[],'findings':[],**overrides}))
        return path

    def test_real_git_small_developer_through_supplement_review_qa_waits_for_human(self):
        self.admit()
        native=self.f.root/'kimi-native'
        self.f.g('worktree','add','-qb','kimi-task',str(native))
        (native/'source.txt').write_text('lane1')
        self.row.update(status='in_progress',assignee_id='kimi-dev')
        self.f.fake.runs['id-1']=[{'id':'kimi-run','issue_id':'id-1','agent_id':'kimi-dev','status':'running','work_dir':str(native)}]
        criterion=dict(core.requirements(self.row['description'])[0],kind='engineering',required=True,check_ids=['normal'])
        plan={'engineering':True,'decisions':[],'criteria':[criterion],'checks':{'normal':{'argv':['python3','check.py'],'cwd':'.','proof':{'kind':'json','pointer':'/passed','equals':True}}},'allowed_paths':['source.txt']}
        plan_path=self.f.root/'plan.json';plan_path.write_text(json.dumps(plan))
        report=self.f.root/'formal.json';report.write_text(json.dumps({'outcome':'synthetic correct value','gaps':[],'decisions':[],'criterion_results':[{'id':'AC-1','status':'pass'}],'complete_contract_review':True}))
        base=self.f.g('rev-parse','HEAD')
        self.c.github.api=lambda path:{'sha':base}
        def publish(lane):lane['pr_number']=1;self.c.save(lane)
        with patch.dict(os.environ,MULTICA_AGENT_ID='kimi-dev',MULTICA_TASK_ID='kimi-run'), patch('pathlib.Path.cwd',return_value=native), patch.object(self.c,'publish_pr',side_effect=publish):
            self.c.workspace('PIT-1',native);self.c.plan('PIT-1',plan_path)
            local_report=native/'.pipeline-local/formal.json';local_report.parent.mkdir(exist_ok=True);local_report.write_bytes(report.read_bytes())
            self.c.stage('PIT-1','developer',local_report,native)
        lane=self.c.lanes()['PIT-1'];head=lane['artifact']['commit']
        self.assertEqual(lane['artifact']['actors'],{'developer':'kimi-dev','reviewer':'review','qa':'qa'})
        self.c.observation['issues']={'PIT-1':{'prs':[{'number':1,'head':head,'base':'main','state':'DRAFT','ci':{'state':'success'}}]}}
        self.f.fake.runs['id-1'][0]['status']='completed';self.c.drain(True)
        self.f.fake.runs['id-1']=[{'id':'supp-run','issue_id':'id-1','agent_id':'kimi-review','status':'running','work_dir':str(self.f.repo)}]
        with self.runtime(),self.in_repo():
            bundle=self.c.supplemental_bundle('PIT-1')
            self.c.supplemental_submit('PIT-1',self.report(bundle))
        self.f.fake.runs['id-1'][0]['status']='completed';self.c.drain(True)
        for role in ('reviewer','qa'):
            folder=self.f.root/role;self.f.g('worktree','add','--detach',str(folder),base)
            with self.f.runtime(role,folder):
                self.c.checkout('PIT-1',role,folder)
                local_report=folder/'.pipeline-local/formal.json';local_report.parent.mkdir(exist_ok=True);local_report.write_bytes(report.read_bytes())
                self.c.stage('PIT-1',role,local_report,folder)
            self.f.fake.runs['id-1'][0]['status']='completed';self.c.drain(True)
        lane=self.c.lanes()['PIT-1']
        self.assertEqual(lane['phase'],'awaiting_merge')
        self.assertEqual(set(lane['receipts']),{'developer','reviewer','qa'})
        self.assertEqual(self.f.g('rev-parse','HEAD'),base)
        self.assertFalse(any(a[:2]==['issue','update'] and 'done' in a for a in self.f.fake.writes))

    def test_default_route_and_disabled_features_never_enroll_new_actors(self):
        self.c.c['optional_roles']['small_tasks_enabled']=False
        self.c.c['optional_roles']['supplemental_enabled']=False
        lane=self.admit(False,False)
        self.assertEqual(lane['routing']['actors'],{'developer':'dev','reviewer':'review','qa':'qa'})
        self.assertNotIn('supplemental',lane['routing']['actors'])

    def test_explicit_selection_requires_enabled_known_distinct_actors(self):
        for changes in ({'small_tasks_enabled':False},{'small_tasks_agent':None},{'small_tasks_agent':'review'}, {'supplemental_agent':'kimi-dev'}, {'supplemental_enabled':False}):
            config=copy.deepcopy(self.c.c['optional_roles']);self.c.c['optional_roles'].update(changes)
            self.row['metadata'].update(developer_route='small',supplemental_review='on')
            result=controller.Controller.dispatch(self.c,True)
            self.assertIn('PIT-1',result['held']);self.assertEqual(self.f.fake.writes,[])
            self.c.c['optional_roles']=config
        self.row['metadata']['developer_route']='typo'
        self.assertIn('PIT-1',controller.Controller.dispatch(self.c)['held'])

    def test_admission_freezes_selected_actor_and_does_not_duplicate(self):
        lane=self.admit()
        self.assertEqual(lane['routing']['actors']['developer'],'kimi-dev')
        assign=next(a for a in self.f.fake.writes if a[:2]==['issue','assign'])
        self.assertEqual(assign[assign.index('--to-id')+1],'kimi-dev')
        self.assertEqual(controller.Controller.dispatch(self.c,True)['started'],[])
        self.row['metadata']['developer_route']='default'
        with self.assertRaisesRegex(controller.Hold,'Frozen'):self.c.verify_routing(lane,self.row)

    def test_selected_runtime_identity_and_legacy_no_adoption(self):
        lane=self.admit(supplement=False)
        self.row.update(status='in_progress',assignee_id='kimi-dev')
        self.f.fake.runs['id-1']=[{'id':'k-run','issue_id':'id-1','agent_id':'kimi-dev','status':'running','work_dir':str(self.f.repo)}]
        with patch.dict(os.environ,MULTICA_AGENT_ID='kimi-dev',MULTICA_TASK_ID='k-run'), self.in_repo():
            self.assertEqual(self.c.current('PIT-1','developer')[0]['routing'],lane['routing'])
        with patch.dict(os.environ,MULTICA_AGENT_ID='dev',MULTICA_TASK_ID='k-run'), self.in_repo():
            with self.assertRaisesRegex(controller.Hold,'identity'):self.c.current('PIT-1','developer')
        lane.pop('routing')
        with self.assertRaisesRegex(controller.Hold,'Legacy'):self.c.verify_routing(lane,self.row)

    def test_developer_exit_ci_then_supplement_before_formal_review(self):
        lane=self.fixture.lane(ci='pending')
        self.row['metadata'].update(developer_route='small',supplemental_review='on')
        lane['routing']=self.c.routing(self.row)
        lane['pending'].update(actor='kimi-dev',assignee='kimi-dev')
        self.row['assignee_id']='kimi-dev';self.f.fake.runs['id-1'][0]['agent_id']='kimi-dev'
        self.c.save(lane)
        self.assertIn('waiting',self.c.drain(True)[0])
        self.c.observation['issues']['PIT-1']['prs'][0]['ci']['state']='success'
        self.f.fake.runs['id-1'][0]['status']='running'
        self.assertIn('waiting',self.c.drain(True)[0])
        self.f.fake.runs['id-1'][0]['status']='completed'
        self.assertEqual(self.c.drain(True)[0]['status'],'supplemental')
        self.assertEqual(self.c.lanes()['PIT-1']['phase'],'supplemental')
        self.assertEqual(self.row['assignee_id'],'kimi-review')
        self.assertEqual(self.c.drain(True),[])
        self.assertEqual(self.c.dispatch(True)['started'],[])

    def test_advisory_report_handoff_preserves_formal_review_and_has_no_checks(self):
        self.prepared()
        with self.runtime(), self.in_repo(), patch.object(self.c,'checks',side_effect=AssertionError('must not execute checks')):
            bundle=self.c.supplemental_bundle('PIT-1')
            self.assertEqual(self.c.supplemental_bundle('PIT-1'),bundle)
            finding={'location':'source.txt:1','trigger':'example input','impact':'wrong output','evidence':'diff hunk'}
            self.c.supplemental_submit('PIT-1',self.report(bundle,findings=[finding]))
            with self.assertRaises(controller.Hold):self.c.supplemental_submit('PIT-1',self.report(bundle))
        self.assertIn('waiting',self.c.drain(True)[0])
        self.f.fake.runs['id-1'][0]['status']='completed'
        self.c.drain(True)
        lane=self.c.lanes()['PIT-1']
        self.assertEqual(lane['phase'],'reviewer');self.assertEqual(self.row['assignee_id'],'review')
        self.assertNotIn('reviewer',lane['receipts']);self.assertNotIn('qa',lane['receipts'])
        self.assertEqual(lane['repairs'],0)
        self.assertNotIn('completion_decision',lane)

    def test_incomplete_formal_or_stale_report_refuses(self):
        self.prepared()
        with self.runtime(), self.in_repo():
            bundle=self.c.supplemental_bundle('PIT-1')
            for change in ({'completed':False},{'inputs_sha256':'wrong'},{'gaps':['missing test']}, {'failures':['failed']},{'not_run':['required']},{'verdict':'pass'},{'findings':[{}]}):
                with self.assertRaises(controller.Hold):self.c.supplemental_submit('PIT-1',self.report(bundle,**change))
            self.assertNotIn('supplemental_receipt',self.c.lanes()['PIT-1'])
            path=Path(next(iter(bundle['inputs']['evidence'].values()))['path']);path.write_text('changed')
            with self.assertRaisesRegex(controller.Hold,'stale'):self.c.supplemental_submit('PIT-1',self.report(bundle))

    def test_declared_developer_evidence_is_bound_and_revalidated(self):
        lane=self.prepared()
        with self.runtime(),self.in_repo():
            bundle=self.c.supplemental_bundle('PIT-1')
            declared=bundle['inputs']['declared_developer_evidence']
            self.assertTrue(any(x['path'].endswith('extra-evidence.txt') for x in declared['manifest']['files']))
            retained=Path(declared['root'])/'files/.pipeline-local/extra-evidence.txt'
            retained.write_text('altered observation')
            with self.assertRaisesRegex(controller.Hold,'evidence incomplete or invalid'):
                self.c.supplemental_submit('PIT-1',self.report(bundle))
            self.assertNotIn('supplemental_receipt',self.c.lanes()['PIT-1'])
            with self.assertRaises(controller.Hold):self.c.supplemental_bundle('PIT-1')

    def test_missing_developer_manifest_refuses_bundle(self):
        lane=self.prepared();lane['receipts']['developer'].pop('retained_evidence');self.c.save(lane)
        with self.runtime(),self.in_repo():
            with self.assertRaisesRegex(controller.Hold,'manifest missing'):self.c.supplemental_bundle('PIT-1')

    def test_read_only_review_rejects_tracked_source_edits(self):
        self.prepared()
        with self.runtime(), self.in_repo():
            bundle=self.c.supplemental_bundle('PIT-1')
            (self.f.repo/'source.txt').write_text('unauthorized repair')
            with self.assertRaisesRegex(controller.Hold,'tracked source changed'):
                self.c.supplemental_submit('PIT-1',self.report(bundle))
            self.assertNotIn('supplemental_receipt',self.c.lanes()['PIT-1'])

    def test_missing_evidence_and_wrong_actor_are_not_success(self):
        self.prepared()
        with self.runtime(), self.in_repo():
            with self.assertRaisesRegex(controller.Hold,'formal stage'):self.c.stage('PIT-1','supplemental',self.f.root/'absent',self.f.repo)
            path=self.c.root/'evidence/PIT-1/1/developer/dev-run/logs/normal.stdout';path.unlink()
            with self.assertRaisesRegex(controller.Hold,'Missing'):self.c.supplemental_bundle('PIT-1')
        with patch.dict(os.environ,MULTICA_AGENT_ID='review',MULTICA_TASK_ID='supp-run'), self.in_repo():
            with self.assertRaisesRegex(controller.Hold,'identity'):self.c.supplemental_bundle('PIT-1')

    def test_changed_head_and_changed_report_block_forward_handoff(self):
        self.prepared()
        with self.runtime(), self.in_repo():
            bundle=self.c.supplemental_bundle('PIT-1');self.c.supplemental_submit('PIT-1',self.report(bundle))
        self.f.fake.runs['id-1'][0]['status']='completed'
        self.c.observation['issues']['PIT-1']['prs'][0]['head']='b'*40
        with self.assertRaises(controller.Hold):self.c.drain(True)
        lane=self.c.lanes()['PIT-1'];self.c.observation['issues']['PIT-1']['prs'][0]['head']=lane['artifact']['commit']
        Path(lane['supplemental_receipt']['report_path']).write_text('{}')
        with self.assertRaises(controller.Hold):self.c.drain(True)

    def test_rework_keeps_selected_developer_and_invalidates_advisory(self):
        lane=self.admit();lane.update(phase='exit-reviewer-g1',native_head='native',artifact={'commit':'public'},contract={'allowed_paths':['source.txt']},supplemental_bundle='old',supplemental_receipt={'old':True},pending={'run':'review-run','engineering_verified':False})
        self.row.update(status='started_2',assignee_id='review');self.c.save(lane)
        self.c._transition(lane,self.row,'todo','report')
        updated=self.c.lanes()['PIT-1']
        self.assertEqual(self.row['assignee_id'],'kimi-dev');self.assertEqual(updated['repairs'],1)
        self.assertEqual(updated['routing'],lane['routing'])
        self.assertNotIn('supplemental_bundle',updated);self.assertNotIn('supplemental_receipt',updated)

    def test_uncertain_supplement_enqueue_is_never_replayed(self):
        lane=self.fixture.lane();self.row['metadata'].update(developer_route='small',supplemental_review='on');lane['routing']=self.c.routing(self.row)
        lane['pending'].update(actor='kimi-dev',assignee='kimi-dev');self.row['assignee_id']='kimi-dev';self.f.fake.runs['id-1'][0]['agent_id']='kimi-dev';self.c.save(lane)
        self.f.fake.fail_update=True
        with self.assertRaises(TimeoutError):self.c.drain(True)
        count=len(self.f.fake.writes)
        self.assertEqual(self.c.drain(True),[])
        self.assertEqual(len(self.f.fake.writes),count)
        self.assertIsNotNone(self.c.db.execute("SELECT 1 FROM operations WHERE state='uncertain'").fetchone())


class OptionalRecovery(unittest.TestCase):
    def test_recovery_requeues_the_frozen_small_developer(self):
        case=DeveloperRecovery()
        case.setUp()
        try:
            case.c.c['optional_roles']={'small_tasks_enabled':True,'small_tasks_agent':'kimi-dev'}
            row=case.f.fake.rows[0];row['metadata']['developer_route']='small';row['assignee_id']='kimi-dev'
            case.f.fake.runs['id-1'][0]['agent_id']='kimi-dev'
            lane=case.c.lanes()['PIT-1'];lane['routing']=case.c.routing(row);case.c.save(lane)
            case.recover()
            request=case.requests[-1]
            self.assertEqual(request[request.index('--assignee-id')+1],'kimi-dev')
            self.assertEqual(case.c.lanes()['PIT-1']['routing'],lane['routing'])
        finally:case.tearDown()


if __name__=='__main__':unittest.main()

class FullSerialChain(SerialBehavior):
    # Reuse only fixture setup; inherited negatives remain independently executable.
    def test_real_git_dev_review_qa_wait_merge_then_integrated_done(self):
        f=self.f;c=self.c;f.fake.rows=[core.item(1)]
        class Remote:
            def api(self,path):
                if path=='commits/main':return {'sha':f.g('rev-parse','HEAD')}
                raise AssertionError(path)
            def ci(self,sha,event):return {'state':'success','sha':sha,'run_id':1}
        c.github=Remote()
        c.observation={'deadline_monotonic':time.monotonic()+120,'issues':{}}
        self.assertEqual(c.dispatch(True)['started'],['PIT-1'])
        native=f.root/'dev-native';f.g('worktree','add','-qb','dev-source',str(native));(native/'source.txt').write_text('lane1')
        plan={'engineering':True,'decisions':[],'criteria':[{**core.requirements(core.DESCRIPTION)[0],'kind':'engineering','required':True,'check_ids':['normal']}],
              'checks':{'normal':{'argv':['python3','check.py'],'cwd':'.','proof':{'kind':'json','pointer':'/passed','equals':True}}},'allowed_paths':['source.txt','check.py']}
        pp=f.root/'plan.json';pp.write_text(json.dumps(plan));rp=f.root/'report.json'
        note={'outcome':'source returns lane1','gaps':[],'decisions':[],'criterion_results':[{'id':'AC-1','status':'pass'}]};rp.write_text(json.dumps(note))
        def published(lane):lane['pr_number']=1;lane['branch']='codex/pit-1-delivery-g1';c.save(lane)
        with patch.object(c,'publish_pr',side_effect=published):
            with f.runtime('developer',native):
                c.workspace('PIT-1',native);c.plan('PIT-1',pp);c.stage('PIT-1','developer',core.bound_report(native,rp),native)
        artifact=c.lanes()['PIT-1']['artifact']
        c.observation={'deadline_monotonic':time.monotonic()+120,'issues':{'PIT-1':{'prs':[{'number':1,'head':artifact['commit'],'state':'DRAFT','base':'main','ci':{'state':'success'}}]}}}
        self.assertEqual(c.drain(True)[0]['waiting'],'preceding runtime not successfully terminal')
        f.fake.runs['id-1'][0]['status']='completed';c.drain(True)
        self.assertEqual(f.fake.rows[0]['status'],'started_2')
        for role,status in [('reviewer','started_3'),('qa','in_review')]:
            work=f.root/(role+'-native');f.g('worktree','add','--detach',str(work))
            current=dict(note)
            if role=='reviewer':current['complete_contract_review']=True
            rp.write_text(json.dumps(current))
            with f.runtime(role,work):
                c.checkout('PIT-1',role,work);c.stage('PIT-1',role,core.bound_report(work,rp),work)
            f.fake.runs['id-1'][0]['status']='completed';c.drain(True)
            self.assertEqual(f.fake.rows[0]['status'],status)
        self.assertEqual(c.lanes()['PIT-1']['phase'],'awaiting_merge')
        self.assertEqual(c.dispatch(True)['started'],[])
        pr=c.observation['issues']['PIT-1']['prs'][0];pr['state']='OPEN'
        c.record_merge_approval('PIT-1',artifact['commit'])
        f.g('merge','--squash',artifact['commit']);f.g('commit','-qm','Explicit synthetic human-approved squash')
        merged=f.g('rev-parse','HEAD');remote=f.root/'remote.git';subprocess.run(['git','clone','--bare',str(f.repo),str(remote)],check=True,capture_output=True)
        f.g('remote','add','origin',str(remote))
        pr=c.observation['issues']['PIT-1']['prs'][0];pr.update(state='MERGED',merge_sha=merged,integration_ci={'state':'success'})
        c.drain(True);self.assertEqual(f.fake.rows[0]['status'],'done');self.assertEqual(c.lanes()['PIT-1']['phase'],'done');self.assertEqual(c.lanes()['PIT-1']['integration']['commit'],merged)
        updates=len(f.fake.writes);c.drain(True);self.assertEqual(len(f.fake.writes),updates)

class ReworkPublication(SerialBehavior):
    def test_rework_fast_forwards_original_branch_without_new_pr(self):
        f=self.f;old=f.g('rev-parse','HEAD');remote=f.root/'remote.git'
        subprocess.run(['git','clone','--bare',str(f.repo),str(remote)],check=True,capture_output=True)
        branch='codex/pit-1-delivery-g1'
        subprocess.run(['git','--git-dir',str(remote),'update-ref','refs/heads/'+branch,old],check=True)
        f.g('remote','add','origin',str(remote));(f.repo/'source.txt').write_text('repair');f.g('commit','-qam','repair')
        sha=f.g('rev-parse','HEAD')
        lane={'issue':'PIT-1','id':'id-1','generation':2,'phase':'developer','artifact':{'commit':sha},'rework_branch':branch,'rework_pr_number':7,'rework_public_commit':old}
        class Remote:
            def api(self,path):return {'state':'open','base':{'ref':'main'},'head':{'sha':old,'ref':branch}}
        self.c.github=Remote();original=serial.subprocess.run;calls=[]
        def run(args,**kwargs):
            if args[0]=='gh':calls.append(args);raise AssertionError('Unexpected replacement PR')
            return original(args,**kwargs)
        with patch.object(serial.subprocess,'run',side_effect=run):self.c.publish_pr(lane)
        self.assertEqual(calls,[]);self.assertEqual(lane['pr_number'],7);self.assertEqual(lane['branch'],branch)
        target=subprocess.check_output(['git','--git-dir',str(remote),'rev-parse','refs/heads/'+branch],text=True).strip();self.assertEqual(target,sha)


class SerialCapacity(unittest.TestCase):
    def make(self, issues, histories=None, lanes=None):
        c = serial.Serial.__new__(serial.Serial)
        c.c = {'developer': 'dev', 'reviewer': 'review', 'qa': 'qa'}
        c.lanes = lambda: lanes or {}
        c.call = lambda args: (histories or {}).get(args[2], [])
        return c

    def test_idle_human_work_does_not_occupy_automatic_lane(self):
        human = {'id': 'human', 'identifier': 'PIT-24', 'status': 'in_progress', 'assignee_id': 'owner'}
        c = self.make([human], {'human': [{'status': 'completed'}]})
        before = copy.deepcopy(human)
        self.assertEqual(c.active_issues([human]), set())
        self.assertEqual(human, before)

    def test_pipeline_owned_work_and_merge_wait_consume_capacity(self):
        task = {'id': 'task', 'identifier': 'PIT-1', 'status': 'todo', 'assignee_id': 'dev'}
        c = self.make([task])
        self.assertEqual(c.active_issues([task]), {'PIT-1'})
        c = self.make([], lanes={'PIT-2': {'issue': 'PIT-2', 'phase': 'awaiting_merge'}})
        self.assertEqual(c.active_issues([]), {'PIT-2'})

    def test_live_runs_block_even_after_reassignment_or_unassignment(self):
        for owner in ('owner', None):
            task = {'id': 'task', 'identifier': 'PIT-1', 'status': 'in_review', 'assignee_id': owner}
            for state in serial.RUNNING:
                c = self.make([task], {'task': [{'status': state}]})
                self.assertEqual(c.active_issues([task]), {'PIT-1'})

    def test_unknown_runtime_history_holds(self):
        task = {'id': 'task', 'identifier': 'PIT-1', 'status': 'in_progress', 'assignee_id': 'owner'}
        for history in ({}, [None], [{}], [{'status': 'future_unknown'}]):
            with self.assertRaises(serial.Hold):
                self.make([task], {'task': history}).active_issues([task])
        c = self.make([task])
        def outage(args): raise gs.SyncError('unavailable')
        c.call = outage
        with self.assertRaises(gs.SyncError): c.active_issues([task])

    def test_real_dispatch_starts_one_without_touching_idle_human_then_no_duplicate(self):
        fixture = SerialBehavior(); fixture.setUp()
        try:
            human = core.item(24, 'in_progress'); human['assignee_id'] = 'owner'
            fixture.old_call.rows = [human, core.item(1), core.item(2)]
            fixture.c.github.api = lambda path: {'sha': fixture.f.g('rev-parse', 'HEAD')}
            fixture.c.github.ci = lambda sha, event: {'state': 'success'}
            fixture.c.observation = {'deadline_monotonic': time.monotonic() + 120, 'issues': {}}
            result = fixture.c.dispatch(True)
            self.assertEqual(result['started'], ['PIT-1'])
            self.assertEqual(fixture.c.dispatch(True)['started'], [])
            self.assertEqual(human['status'], 'in_progress')
            self.assertEqual(human['assignee_id'], 'owner')
            self.assertFalse(any('id-24' in args for args in fixture.old_call.writes))
        finally: fixture.tearDown()

    def test_only_exact_status_tool_paths_allowed_for_publication(self):
        import importlib.util
        path = Path(__file__).resolve().parents[1] / 'pitchroom-github-sync/delivery.py'
        spec = importlib.util.spec_from_file_location('capacity_delivery', path)
        mod = importlib.util.module_from_spec(spec); spec.loader.exec_module(mod)
        for name in ('snapshot.py', 'test_snapshot.py', 'view.py', 'test_view.py'):
            self.assertTrue(mod.allowed_path('tooling/pipeline-status/' + name))
        for name in ('secrets.json', '.env', 'extra.py', '../pipeline/serial.py'):
            self.assertFalse(mod.allowed_path('tooling/pipeline-status/' + name))


class QAResubmission(unittest.TestCase):
    def setUp(self):
        self.f=SerialBehavior();self.f.setUp();self.c=self.f.c
        lane=self.f.lane(target='in_review');lane.pop('pending');lane['phase']='held'
        lane['receipts']={'qa':{'outcome':'pass','gaps':['qa has not_run'],'commit':SHA,'run_id':'qa-old'}}
        self.c.save(lane)
        self.f.old_call.rows[0].update(status='in_review',assignee_id='owner')
        self.f.old_call.runs['id-1']=[{'id':'qa-old','agent_id':'qa','status':'completed'}]

    def tearDown(self):self.f.tearDown()

    def test_reassessment_exit_has_own_transition_and_repeated_tick_is_safe(self):
        lane=self.c.lanes()['PIT-1'];row=self.f.old_call.rows[0]
        row.update(status='started_3',assignee_id='qa')
        def pending(run, verified):
            return {'target':'in_review','role':'qa','run':run,'actor':'qa',
                'issue_status':'started_3','assignee':'qa','report':'local-report',
                'source_description':lane['description_sha256'],'engineering_verified':verified}
        lane.update(phase='awaiting_role_exit',pending=pending('qa-old',False))
        self.c.save(lane);self.c.drain(True)
        self.assertEqual(self.c.lanes()['PIT-1']['phase'],'held')
        old_operations=self.c.db.execute('SELECT token,state FROM operations').fetchall()
        self.c.retry_qa('PIT-1',SHA,'Scoped report reassessment')
        self.f.old_call.runs['id-1'].append({'id':'qa-new','agent_id':'qa','status':'completed'})
        next_lane=self.c.lanes()['PIT-1'];next_lane.update(phase='awaiting_role_exit',pending=pending('qa-new',True))
        next_lane['receipts']['qa']={'outcome':'pass','gaps':[],'commit':SHA,'run_id':'qa-new'}
        self.c.save(next_lane);self.c.drain(True)
        self.assertEqual(self.c.lanes()['PIT-1']['phase'],'awaiting_merge')
        self.assertEqual(row['status'],'in_review')
        current=self.c.db.execute('SELECT token,state FROM operations').fetchall()
        self.assertTrue(all(operation in current for operation in old_operations))
        count=len(self.f.old_call.writes);self.c.drain(True)
        self.assertEqual(len(self.f.old_call.writes),count)
        archive=json.loads((self.c.root/'qa-retries/PIT-1-g1.json').read_text())
        self.assertEqual(archive['original_lane']['receipts']['qa']['run_id'],'qa-old')

    def test_archives_failure_and_persists_next_state_before_enqueue(self):
        before=copy.deepcopy(self.c.lanes()['PIT-1']);original=self.c.call;observed=[]
        def call(args):
            if args[:2]==['issue','update']:
                observed.append(self.c.lanes()['PIT-1']['phase'])
                self.assertTrue((self.c.root/'qa-retries/PIT-1-g1.json').exists())
            return original(args)
        self.c.call=call
        result=self.c.retry_qa('PIT-1',SHA,'Report scope reconciliation; no source changes')
        self.assertEqual(result['qa_retries'],1);self.assertEqual(observed,['qa'])
        archive=json.loads(Path(result['original_evidence']).read_text())
        self.assertEqual(archive['original_lane'],before)
        self.assertEqual(self.c.lanes()['PIT-1']['artifact'],before['artifact'])
        self.assertNotIn('qa',self.c.lanes()['PIT-1']['receipts'])
        count=len(self.f.old_call.writes)
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'repeat')
        self.assertEqual(len(self.f.old_call.writes),count)

    def test_role_changed_head_contract_live_and_ci_refuse(self):
        from unittest.mock import patch
        import os
        before=copy.deepcopy(self.c.lanes()['PIT-1'])
        with patch.dict(os.environ,MULTICA_TASK_ID='actual-role'):
            with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1','b'*40,'reason')
        self.f.old_call.rows[0]['description']+='changed'
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        self.f.old_call.rows[0]['description']=before['description'] if 'description' in before else core.DESCRIPTION
        self.f.old_call.runs['id-1'][0]['status']='running'
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        self.f.old_call.runs['id-1'][0]['status']='completed'
        self.c.observation['issues']['PIT-1']['prs'][0]['ci']['state']='cancelled'
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        self.assertFalse(self.f.old_call.writes)

    def test_lost_enqueue_response_stays_uncertain_and_cannot_replay(self):
        self.f.old_call.fail_update=True
        with self.assertRaises(TimeoutError):self.c.retry_qa('PIT-1',SHA,'reason')
        count=len(self.f.old_call.writes)
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        self.assertEqual(len(self.f.old_call.writes),count)
        self.assertEqual(self.c.db.execute("SELECT count(*) FROM operations WHERE state='uncertain'").fetchone()[0],1)

    def test_other_live_run_on_same_issue_refuses_and_retry_cap_is_explicit(self):
        before=copy.deepcopy(self.c.lanes()['PIT-1'])
        for status in serial.RUNNING:
            for actor in ('qa','dev',None):
                self.f.old_call.runs['id-1']=[{'id':'qa-old','agent_id':'qa','status':'completed'},
                    {'id':'other-live','agent_id':actor,'status':status}]
                with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
                self.assertFalse(self.f.old_call.writes)
                self.assertEqual(self.c.lanes()['PIT-1'],before)
        self.f.old_call.runs['id-1']=[{'id':'qa-old','agent_id':'qa','status':'completed'}]
        before['qa_retries']=1;self.c.save(before)
        with self.assertRaisesRegex(serial.Hold,'retry limit'):self.c.retry_qa('PIT-1',SHA,'reason')
        self.assertFalse(self.f.old_call.writes)

    def test_expired_or_unknown_history_holds_before_write(self):
        self.c.observation['deadline_monotonic']=0
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        self.c.observation['deadline_monotonic']=time.monotonic()+120
        self.f.old_call.runs['id-1']=[{'id':'qa-old','status':'unknown'}]
        count=len(self.f.old_call.writes)
        with self.assertRaises(serial.Hold):self.c.retry_qa('PIT-1',SHA,'reason')
        self.assertEqual(len(self.f.old_call.writes),count)

    def test_checks_keep_each_run_and_reject_same_run_resubmission(self):
        root=self.c.root/'evidence/PIT-1/1/qa';root.mkdir(parents=True)
        (root/'original.json').write_text('first failed report retained')
        lane={'issue':'PIT-1','generation':1,'contract':{'checks':{}},'artifact':{'tree':'tree'}}
        from unittest.mock import patch
        import controller
        with patch.object(controller,'verify_dependencies'),patch.object(controller,'verify_clean_tree'):
            lane['dependencies']={}
            one=self.c.checks(lane,'qa',self.f.f.repo,run_id='qa-one')
            two=self.c.checks(lane,'qa',self.f.f.repo,run_id='qa-two')
            self.assertNotEqual(one,two);self.assertTrue(one.is_dir());self.assertTrue(two.is_dir())
            with self.assertRaises(serial.Hold):self.c.checks(lane,'qa',self.f.f.repo,run_id='qa-one')
        self.assertEqual((root/'original.json').read_text(),'first failed report retained')


class DeveloperRecovery(unittest.TestCase):
    def setUp(self):
        self.fixture=SerialBehavior();self.fixture.setUp()
        self.f,self.c=self.fixture.f,self.fixture.c
        f=self.f;baseline=f.g('rev-parse','HEAD')
        f.g('checkout','-qb','agent/native')
        (f.repo/'private-native.txt').write_text('runtime history stays local')
        (f.repo/'source.txt').write_text('old')
        f.g('add','private-native.txt','source.txt');f.g('commit','-qm','native prior')
        self.prior=f.g('rev-parse','HEAD')
        (f.repo/'source.txt').write_text('lane1');f.g('commit','-qam','preserved repair')
        self.source=f.g('rev-parse','HEAD')
        f.g('checkout','-qb','public-history',baseline)
        (f.repo/'source.txt').write_text('old');f.g('commit','-qam','prior public')
        self.head=f.g('rev-parse','HEAD')
        f.g('checkout','main');(f.repo/'new-main.txt').write_text('accepted baseline')
        f.g('add','new-main.txt');f.g('commit','-qm','main advances independently')
        self.main=f.g('rev-parse','HEAD')
        row=f.fake.rows[0];row.update(status='in_progress',assignee_id='dev',revision=7)
        f.fake.rows=[row]
        self.oldwork=str(f.root/'removed-native-worktree')
        f.fake.runs['id-1']=[{'id':'old-dev','issue_id':'id-1','agent_id':'dev','status':'completed','work_dir':self.oldwork,'branch_name':'agent/native'}]
        criteria=[dict(x,kind='engineering',required=True,check_ids=['normal']) for x in core.requirements(row['description'])]
        contract={'schema_version':1,'engineering':True,'decisions':[],'description_sha256':serial.digest(row['description']),
                  'criteria':criteria,'allowed_paths':['source.txt'],'checks':{'normal':{'argv':['python3','check.py'],'cwd':'.','proof':{'kind':'json','pointer':'/passed','equals':True}}}}
        self.lane={'issue':'PIT-1','id':'id-1','phase':'developer','generation':3,'repairs':2,'native_head':self.prior,
                   'description_sha256':serial.digest(row['description']),'requirements':core.requirements(row['description']),
                   'description':row['description'],'contract':contract,'developer_workspace':self.oldwork,
                   'dependencies':{},'rework_base_commit':self.prior,'rework_public_commit':self.head,
                   'rework_paths':['source.txt'],'rework_branch':'codex/pit-1-delivery-g1','rework_pr_number':7}
        self.c.save(self.lane);self.requests=[];old_call=self.c.call
        def call(args):
            if args[:2]==['issue','rerun']:
                self.requests.append(args);return {'id':'unbound-current-assignment-run'}
            if args[:2]==['issue','update'] and '--assignee-id' in args:
                self.requests.append(args)
                result=old_call(args)
                self.f.fake.rows[0]['revision']+=1
                target=args[args.index('--status')+1]
                if target=='todo' and '--no-start' not in args and not getattr(self,'no_run',False):
                    self.f.fake.runs['id-1'].append({'id':'fresh-dev','issue_id':'id-1','agent_id':'dev',
                        'status':'queued','created_at':serial.datetime.now(serial.timezone.utc).isoformat()})
                if getattr(self,'lost_enqueue',False):raise TimeoutError('acknowledgement lost')
                if target=='todo' and getattr(self,'lost_after_start',False):raise TimeoutError('start response lost')
                return result
            return old_call(args)
        self.c.call=call
        outer=self
        class Remote:
            def api(self,path):
                if path=='commits/main':return {'sha':outer.main}
                return {'state':'open','base':{'ref':'main'},'head':{'sha':outer.head,'ref':'codex/pit-1-delivery-g1'}}
            def ci(self,sha,event):return {'state':'success'}
        self.c.github=Remote()
        self.c.observation={'deadline_monotonic':time.monotonic()+120,'issues':{'PIT-1':{'prs':[{'number':7,'head':self.head,'state':'DRAFT','base':'main','ci':{'state':'success','sha':self.head}}]}}}

    def tearDown(self):self.fixture.tearDown()

    def recover(self,**overrides):
        args=dict(key='PIT-1',generation=3,head=self.head,main=self.main,run_id='old-dev',source=self.source,reason='preserved repair after main advance')
        args.update(overrides);return self.c.recover_developer(**args)

    def test_real_git_recovery_preserves_both_histories_and_exact_scope_once(self):
        result=self.recover();lane=self.c.lanes()['PIT-1']
        self.assertEqual((lane['generation'],lane['repairs']),(3,2))
        self.assertEqual(lane['contract'],self.lane['contract']);self.assertNotIn('artifact',lane)
        public=result['recovered_source'];native=self.f.g('rev-parse','agent/native')
        for ancestor,child in ((self.head,public),(self.main,public),(self.source,native),(public,native)):
            self.assertTrue(serial.has_ancestor(self.f.repo,ancestor,child))
        self.assertEqual(self.f.g('show',public+':source.txt'),'lane1')
        self.assertEqual(self.f.g('diff','--name-only',self.main,public),'source.txt')
        self.assertEqual(self.f.g('show',native+':private-native.txt'),'runtime history stays local')
        self.assertEqual(json.loads(Path(result['archive']).read_text())['original_lane'],self.lane)
        with self.assertRaises(serial.Hold):self.recover()
        self.assertEqual(len(self.requests),2)

    def test_recovered_source_still_requires_real_role_then_fast_forwards_original_pr(self):
        result=self.recover();remote=self.f.root/'remote.git'
        subprocess.run(['git','clone','--bare',str(self.f.repo),str(remote)],check=True,capture_output=True)
        subprocess.run(['git','--git-dir',str(remote),'update-ref','refs/heads/codex/pit-1-delivery-g1',self.head],check=True)
        self.f.g('remote','add','origin',str(remote))
        native=(self.f.root/'fresh-native').resolve();self.f.g('worktree','add','--detach',str(native),'agent/native')
        report=self.f.root/'report.json';report.write_text(json.dumps({'outcome':'pass','criterion_results':[{'id':x['id'],'status':'pass'} for x in self.lane['requirements']],'gaps':[],'decisions':[]}))
        with self.assertRaises(serial.Hold):self.c.stage('PIT-1','developer',core.bound_report(native,report),native)
        with self.f.runtime('developer',native,run='fresh-dev'):
            self.c.workspace('PIT-1',native)
            self.c.stage('PIT-1','developer',core.bound_report(native,report),native)
        lane=self.c.lanes()['PIT-1'];self.assertEqual(lane['phase'],'awaiting_role_exit')
        self.assertEqual(lane['artifact']['commit'],result['recovered_source'])
        self.assertNotIn('rework_expected_pr_head',lane)
        published=subprocess.check_output(['git','--git-dir',str(remote),'rev-parse','refs/heads/codex/pit-1-delivery-g1'],text=True).strip()
        self.assertEqual(published,result['recovered_source']);self.assertEqual(lane['pr_number'],7)

    def test_changed_contract_head_source_or_generation_refuses_without_mutation(self):
        for override in ({'generation':4},{'head':'f'*40},{'source':self.prior},{'source':'HEAD'},{'main':'f'*40}):
            with self.subTest(override=override):
                with self.assertRaises(serial.Hold):self.recover(**override)
        self.f.fake.rows[0]['revision']=None
        with self.assertRaises(serial.Hold):self.recover()
        self.f.fake.rows[0]['revision']=7
        self.f.fake.rows[0]['description']+='changed'
        with self.assertRaises(serial.Hold):self.recover()
        self.assertEqual(self.c.lanes()['PIT-1'],self.lane);self.assertEqual(self.requests,[])
        self.assertEqual(self.f.g('rev-parse','agent/native'),self.source)
        self.assertEqual(self.c.db.execute('select count(*) from operations').fetchone()[0],0)

    def test_live_unknown_and_uncertain_state_refuse(self):
        original=copy.deepcopy(self.f.fake.runs['id-1'])
        for status in ('running','queued','mystery'):
            self.f.fake.runs['id-1']=[dict(original[0],status=status)]
            with self.subTest(status=status):
                with self.assertRaises(serial.Hold):self.recover()
        self.f.fake.runs['id-1']=original
        self.c.reserve('unresolved')
        with self.assertRaisesRegex(serial.Hold,'Uncertain'):self.recover()
        self.assertEqual(self.requests,[])

    def test_task_path_change_on_main_or_unscoped_native_source_refuses(self):
        (self.f.repo/'source.txt').write_text('another main change');self.f.g('commit','-qam','shared path moves')
        self.main=self.f.g('rev-parse','HEAD')
        with self.assertRaisesRegex(serial.Hold,'task paths'):self.recover()
        self.assertEqual(self.requests,[])

    def test_lost_enqueue_never_replays_or_spends_another_repair(self):
        self.lost_enqueue=True
        with self.assertRaises(TimeoutError):self.recover()
        lane=self.c.lanes()['PIT-1'];self.assertEqual((lane['generation'],lane['repairs']),(3,2))
        with self.assertRaisesRegex(serial.Hold,'Uncertain'):self.recover()
        self.assertEqual(len(self.requests),1)
        self.assertTrue(Path(lane['developer_recovery']).exists())

    def test_unscoped_native_commit_and_checked_out_branch_are_not_recovered(self):
        self.f.g('checkout','agent/native')
        (self.f.repo/'private-native.txt').write_text('unexpected native edit')
        self.f.g('commit','-qam','unscoped native change');self.source=self.f.g('rev-parse','HEAD')
        self.f.g('checkout','main')
        with self.assertRaisesRegex(serial.Hold,'declared source'):self.recover()
        self.assertEqual(self.requests,[])

    def test_live_native_checkout_is_not_updated(self):
        other=self.f.root/'still-owned';self.f.g('worktree','add',str(other),'agent/native')
        with self.assertRaisesRegex(serial.Hold,'checked out'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertEqual(self.f.g('rev-parse','agent/native'),self.source)

    def test_role_context_and_unsuccessful_ci_refuse(self):
        with patch.dict(serial.os.environ,{'MULTICA_TASK_ID':'actual-role'}):
            with self.assertRaisesRegex(serial.Hold,'operator'):self.recover()
        self.c.github.ci=lambda *args:{'state':'failure'}
        with self.assertRaisesRegex(serial.Hold,'successful current main'):self.recover()
        self.assertEqual(self.requests,[])

    def test_concurrent_native_ref_update_is_preserved_and_journal_holds(self):
        original=serial.git
        def git(repo,*args):
            if args[0]=='update-ref':
                original(repo,'update-ref','refs/heads/agent/native',self.main,self.source)
            return original(repo,*args)
        with patch.object(serial,'git',side_effect=git):
            with self.assertRaises((serial.Hold,subprocess.CalledProcessError)):self.recover()
        self.assertEqual(self.f.g('rev-parse','agent/native'),self.main)
        self.assertEqual(self.requests,[])
        self.assertEqual(self.c.db.execute("select count(*) from operations where state='uncertain'").fetchone()[0],1)
        self.assertEqual(self.c.lanes()['PIT-1'],self.lane)

    def test_original_publication_gate_still_refuses_unintegrated_rework(self):
        native=(self.f.root/'unintegrated-native').resolve()
        self.f.g('worktree','add','--detach',str(native),self.source)
        with self.assertRaisesRegex(serial.Hold,'base is stale'):
            self.c.publish_checkpoint(self.lane,native,'PIT-1')
        self.assertEqual(self.c.lanes()['PIT-1'],self.lane)
        self.assertEqual(self.requests,[])

    def test_another_project_runtime_started_before_ref_commit_holds(self):
        self.f.fake.rows.append(issue(2))
        original=self.c.github.api
        def api(path):
            if path=='pulls/7':
                self.f.fake.runs['id-2']=[{'id':'other','status':'running'}]
            return original(path)
        self.c.github.api=api
        with self.assertRaisesRegex(serial.Hold,'Live runtime'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertEqual(self.f.g('rev-parse','agent/native'),self.source)
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())

    def test_changed_owner_after_mapping_is_preserved_without_enqueue(self):
        original=serial.write_json
        def write(path,data):
            original(path,data)
            if Path(path).name=='mapping.json':
                self.f.fake.rows[0].update(status='started_3',assignee_id='qa',revision=8)
        with patch.object(serial,'write_json',side_effect=write):
            with self.assertRaisesRegex(serial.Hold,'assignment changed'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertEqual(self.f.fake.rows[0]['assignee_id'],'qa')
        lane=self.c.lanes()['PIT-1'];self.assertTrue(Path(lane['developer_recovery']).exists())
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())

    def test_live_runtime_after_mapping_is_not_enqueued_again(self):
        original=serial.write_json
        def write(path,data):
            original(path,data)
            if Path(path).name=='mapping.json':
                self.f.fake.runs['id-1'].append({'id':'intervening','status':'queued'})
        with patch.object(serial,'write_json',side_effect=write):
            with self.assertRaisesRegex(serial.Hold,'Live runtime'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())

    def test_explicit_transition_binds_developer_from_both_permitted_statuses(self):
        self.f.fake.rows[0]['status']='todo'
        self.recover()
        args=self.requests[0]
        self.assertEqual(args[:2],['issue','update'])
        self.assertEqual(args[args.index('--assignee-id')+1],'dev')
        self.assertEqual(args[args.index('--status')+1],'backlog')
        self.assertIn('--no-start',args)
        self.assertEqual(self.requests[1][self.requests[1].index('--status')+1],'todo')
        self.assertNotIn('--no-start',self.requests[1])

    def test_other_issue_becomes_live_after_local_mapping_holds(self):
        self.f.fake.rows.append(issue(2))
        original=serial.write_json
        def write(path,data):
            original(path,data)
            if Path(path).name=='mapping.json':
                self.f.fake.runs['id-2']=[{'id':'late-other','status':'running'}]
        with patch.object(serial,'write_json',side_effect=write):
            with self.assertRaisesRegex(serial.Hold,'Live runtime'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())

    def test_completed_target_history_change_after_mapping_also_holds(self):
        original=serial.write_json
        def write(path,data):
            original(path,data)
            if Path(path).name=='mapping.json':
                self.f.fake.runs['id-1'].append({'id':'intervening-finished','status':'completed'})
        with patch.object(serial,'write_json',side_effect=write):
            with self.assertRaisesRegex(serial.Hold,'runtime history changed'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())

    def test_malformed_runtime_identities_hold_without_local_effects(self):
        self.f.fake.rows.append(issue(2))
        rows=[{'status':'completed'}]+[{'id':x,'status':'completed'} for x in (None,'',17,False,[],{},' ')]
        for run in rows:
            self.f.fake.runs['id-2']=[run]
            with self.subTest(run=run):
                with self.assertRaisesRegex(serial.Hold,'Unknown runtime history'):self.recover()
                self.assertEqual(self.requests,[])
                self.assertEqual(self.f.g('rev-parse','agent/native'),self.source)
                self.assertEqual(self.c.lanes()['PIT-1'],self.lane)
                self.assertEqual(self.c.db.execute('select count(*) from operations').fetchone()[0],0)

    def test_valid_completed_runtime_identity_still_permits_recovery(self):
        self.f.fake.rows.append(issue(2))
        self.f.fake.runs['id-2']=[{'id':'valid-completed-run','status':'completed'}]
        self.recover()
        self.assertEqual(len(self.requests),2)
        self.assertEqual(self.c.lanes()['PIT-1']['developer_recoveries'],1)

    def test_malformed_identity_after_mapping_holds_without_enqueue(self):
        self.f.fake.rows.append(issue(2))
        original=serial.write_json
        def write(path,data):
            original(path,data)
            if Path(path).name=='mapping.json':
                self.f.fake.runs['id-2']=[{'status':'completed'}]
        with patch.object(serial,'write_json',side_effect=write):
            with self.assertRaisesRegex(serial.Hold,'Unknown runtime history'):self.recover()
        self.assertEqual(self.requests,[])
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())
        self.assertTrue(Path(self.c.lanes()['PIT-1']['developer_recovery']).exists())

    def test_successful_status_update_without_run_stays_uncertain(self):
        self.no_run=True
        result=self.recover()
        self.assertEqual(result['status'],'enqueue_unconfirmed')
        self.assertEqual(len(self.requests),2)
        self.assertTrue(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())
        with self.assertRaises(serial.Hold):self.recover()
        self.assertEqual(len(self.requests),2)

    def test_delayed_run_can_be_observed_without_writes_then_acknowledged_once(self):
        self.no_run=True;self.recover()
        self.f.fake.runs['id-1'].append({'id':'delayed','issue_id':'id-1','agent_id':'dev','status':'running',
            'created_at':serial.datetime.now(serial.timezone.utc).isoformat()})
        before=self.c.db.execute('select * from operations').fetchall()
        files={str(p):p.read_bytes() for p in self.c.root.rglob('*') if p.is_file()}
        self.assertEqual(self.c.inspect_recovery('PIT-1'),{'state':'unique_run_observed','run_id':'delayed'})
        self.assertEqual(before,self.c.db.execute('select * from operations').fetchall())
        self.assertEqual(files,{str(p):p.read_bytes() for p in self.c.root.rglob('*') if p.is_file()})
        with self.assertRaises(serial.Hold):self.c.confirm_recovery('PIT-1','wrong')
        self.c.confirm_recovery('PIT-1','delayed');self.c.confirm_recovery('PIT-1','delayed')
        self.assertFalse(self.c.db.execute("select 1 from operations where state='uncertain'").fetchone())
        self.assertEqual(len(self.requests),2)
        self.assertEqual(len(list((Path(self.c.lanes()['PIT-1']['developer_recovery']).with_suffix('')/'start-events').glob('*.json'))),4)

    def test_lost_start_acknowledgement_is_reconciled_without_enqueue(self):
        self.lost_after_start=True
        with self.assertRaises(TimeoutError):self.recover()
        self.assertEqual(self.c.inspect_recovery('PIT-1')['state'],'unique_run_observed')
        with self.assertRaises(serial.Hold):self.recover()
        self.c.confirm_recovery('PIT-1','fresh-dev')
        self.assertEqual(len(self.requests),2)

    def test_wrong_duplicate_unknown_or_earlier_run_never_confirms(self):
        self.no_run=True;self.recover()
        before=copy.deepcopy(self.f.fake.runs['id-1'])
        valid={'id':'new','issue_id':'id-1','agent_id':'dev','status':'queued','created_at':serial.datetime.now(serial.timezone.utc).isoformat()}
        for rows in [[dict(valid,agent_id='qa')],[dict(valid,issue_id='id-other')],
                     [dict(valid,status='unknown')],[dict(valid,created_at='2000-01-01T00:00:00Z')],
                     [dict(valid,created_at=None)],[valid,dict(valid,id='second')],[valid,valid]]:
            self.f.fake.runs['id-1']=before+rows
            with self.subTest(rows=rows):
                self.assertEqual(self.c.inspect_recovery('PIT-1')['state'],'conflict_or_unavailable')
                with self.assertRaises(serial.Hold):self.c.confirm_recovery('PIT-1','new')
        self.assertEqual(len(self.requests),2)

    def test_missing_parking_ack_never_enqueues(self):
        original=self.c.call
        def call(args):
            value=original(args)
            if args[:2]==['issue','update'] and '--no-start' in args:
                self.f.fake.rows[0]['revision']=7
            return value
        self.c.call=call
        with self.assertRaisesRegex(serial.Hold,'Parking'):self.recover()
        self.assertEqual(len(self.requests),1)
        self.assertEqual(self.c.inspect_recovery('PIT-1')['state'],'not_enqueued_or_unknown')

    def test_prior_runtime_provenance_changes_hold_before_enqueue_and_in_reconciliation(self):
        self.no_run=True;self.recover()
        valid={'id':'new','issue_id':'id-1','agent_id':'dev','status':'queued','created_at':serial.datetime.now(serial.timezone.utc).isoformat()}
        original=copy.deepcopy(self.f.fake.runs['id-1'])
        for key,value in [('agent_id','qa'),('issue_id','other'),('work_dir','another-worktree'),
                          ('branch_name','agent/other'),('created_at','2000-01-01T00:00:00Z'),
                          ('result',{'branch_name':'agent/other'})]:
            self.f.fake.runs['id-1']=[{**original[0],key:value},valid]
            with self.subTest(key=key):
                self.assertEqual(self.c.inspect_recovery('PIT-1')['state'],'conflict_or_unavailable')
                with self.assertRaises(serial.Hold):self.c.confirm_recovery('PIT-1','new')
        self.f.fake.runs['id-1']=original+[valid]
        self.assertEqual(self.c.inspect_recovery('PIT-1')['state'],'unique_run_observed')
        self.assertEqual(len(self.requests),2)

    def test_prior_runtime_owner_change_after_mapping_prevents_parking(self):
        original=serial.write_json
        def write(path,data):
            original(path,data)
            if Path(path).name=='mapping.json':self.f.fake.runs['id-1'][0]['agent_id']='qa'
        with patch.object(serial,'write_json',side_effect=write):
            with self.assertRaisesRegex(serial.Hold,'runtime history changed'):self.recover()
        self.assertEqual(self.requests,[])
