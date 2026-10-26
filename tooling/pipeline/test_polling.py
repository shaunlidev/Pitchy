import copy
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

import github_sync as gs
import serial
import test_controller as core

SHA='a'*40
POLICY={'repository':'owner/repo','project_id':'project'}


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
        self.c.observation={'issues':{'PIT-1':{'prs':[{'number':1,'head':SHA,'state':'DRAFT','ci':{'state':ci}}]}}}
        self.c.save(lane);return lane

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
        c.observation={'issues':{'PIT-1':{'prs':[{'number':1,'head':artifact['commit'],'state':'DRAFT','ci':{'state':'success'}}]}}}
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
        f.g('merge','--no-ff',artifact['commit'],'-m','Explicit synthetic human-approved integration')
        merged=f.g('rev-parse','HEAD');remote=f.root/'remote.git';subprocess.run(['git','clone','--bare',str(f.repo),str(remote)],check=True,capture_output=True)
        f.g('remote','add','origin',str(remote))
        pr=c.observation['issues']['PIT-1']['prs'][0];pr.update(state='MERGED',merge_sha=merged,integration_ci={'state':'success'})
        c.drain(True);self.assertEqual(f.fake.rows[0]['status'],'done');self.assertEqual(c.lanes()['PIT-1']['phase'],'done')
        updates=len(f.fake.writes);c.drain(True);self.assertEqual(len(f.fake.writes),updates)
