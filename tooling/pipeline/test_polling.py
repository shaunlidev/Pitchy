import copy
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
POLICY={'repository':'owner/repo','project_id':'project','merge_policy':'human_approved_squash'}


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
                c.workspace('PIT-1',native);c.plan('PIT-1',pp);c.stage('PIT-1','developer',rp,native)
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
                c.checkout('PIT-1',role,work);c.stage('PIT-1',role,rp,work)
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
