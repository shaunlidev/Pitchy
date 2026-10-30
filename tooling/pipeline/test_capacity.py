"""Synthetic capacity, ownership, crash and integration acceptance. No services."""
import copy
import hashlib
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

from capacity import Capacity, authorized_lanes, inventory, read_status, scope
from controller import Hold
import serial
import status
import test_controller as core

BASE, HEAD, TREE, MERGE = (c * 40 for c in 'abcd')


def issue(n, paths=None, shared=False):
    row = core.item(n)
    row['capacity_actor'] = 'dev'
    row['metadata']['capacity_scope'] = {'paths': paths or [f'features/{n}.txt'], 'shared': shared}
    return row


def observed(count=0, **extra):
    return {'runs': [{'id': f'run-{i}', 'issue_id': f'other-{i}'} for i in range(count)], 'deadline': time.monotonic() + 120, **extra}


class CapacityTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.state = self.root / 'state'
        self.cap = Capacity(self.state); self.addCleanup(lambda: self.cap.close())

    def admit(self, n=1, **kwargs):
        return self.cap.admit(issue(n), BASE, observed(), kwargs.get('limit', 2))

    def bind(self, n=1, run='dev-1', branch='branch-1'):
        path = self.root / run; path.mkdir(exist_ok=True)
        return self.cap.bind(f'PIT-{n}', 'dev', run, path, branch)

    def test_two_independent_lanes_third_and_duplicate_hold(self):
        a, b = self.admit(1), self.admit(2)
        self.assertNotEqual(a['lease_id'], b['lease_id']); self.assertNotEqual(a['port'], b['port'])
        for n in (1, 3):
            with self.assertRaises(Hold): self.admit(n)
        self.assertEqual(len(self.cap.leases()), 2)

    def test_default_single_lane_and_machine_pending_count(self):
        self.admit(limit=1)
        with self.assertRaises(Hold): self.admit(2, limit=1)
        with self.assertRaisesRegex(Hold, 'five'): self.cap.admit(issue(2), BASE, observed(4), 2)
        self.assertEqual(len(self.cap.leases()), 1)

    def test_five_machine_runs_refuse_even_first_lane(self):
        with self.assertRaisesRegex(Hold, 'five'): self.cap.admit(issue(1), BASE, observed(5), 1)
        self.assertEqual(self.cap.leases(), {})

    def test_stale_inventory_cannot_admit_or_retire(self):
        with self.assertRaises(Hold): self.cap.admit(issue(1), BASE, observed(deadline=0), 1)
        self.admit(); self.bind()
        with self.assertRaises(Hold): self.cap.retire('PIT-1', self.cap.get('PIT-1')['lease_id'], observed(deadline=0), {'merge': MERGE, 'evidence': ['retained']})

    def test_overlap_shared_and_sensitive_paths_serialize(self):
        for paths, shared in [(['features/1.txt'], False), (['features/1.txt/nested'], False), (['other'], True), (['db/migrations/1.sql'], False), (['src/core/math.ts'], False), (['package.json'], False), (['src/config.ts'], False)]:
            with self.subTest(paths=paths):
                self.cap.close(); self.cap = Capacity(self.state)
                if not self.cap.leases(): self.admit()
                with self.assertRaisesRegex(Hold, 'serial'): self.cap.admit(issue(2, paths, shared), BASE, observed(), 2)

    def test_invalid_or_missing_scope_holds(self):
        for raw in (None, [], {}, {'paths': ['../x'], 'shared': False}, {'paths': ['*'], 'shared': False}, {'paths': ['a', 'a'], 'shared': False}, {'paths': [[]], 'shared': False}, {'paths':['a'], 'shared': 1}):
            row=issue(1); row['metadata']['capacity_scope']=raw
            with self.subTest(raw=raw), self.assertRaises(Hold): scope(row)

    def test_two_connections_race_for_single_slot(self):
        def attempt(n):
            cap = Capacity(self.state)
            try:
                cap.admit(issue(n), BASE, observed(), 1); return 'admitted'
            except Hold: return 'held'
            finally: cap.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            outcomes = list(pool.map(attempt, (1,2)))
        self.assertEqual(sorted(outcomes), ['admitted','held'])
        self.assertEqual(len(self.cap.leases()), 1)

    def test_crash_reopen_keeps_pending_ownership_no_timeout_release(self):
        lease = self.admit(limit=1)
        self.cap.close(); self.cap = Capacity(self.state)
        self.assertEqual(self.cap.get('PIT-1'), lease)
        with self.assertRaises(Hold): self.admit(2, limit=1)
        with self.assertRaises(Hold): self.cap.reserve_run('PIT-1', 'new-start', 'dev', observed())

    def test_process_exit_after_reservation_keeps_slot_without_replay(self):
        script = "import os; from capacity import Capacity; from test_capacity import issue,observed,BASE; c=Capacity(os.environ['TEST_STATE']);c.admit(issue(1),BASE,observed(),1);os._exit(17)"
        env = {**os.environ, 'TEST_STATE': str(self.state), 'PYTHONPATH': str(Path(__file__).parent)}
        result = subprocess.run([sys.executable, '-B', '-c', script], env=env, capture_output=True)
        self.assertEqual(result.returncode, 17, result.stderr.decode())
        self.assertEqual(self.cap.get('PIT-1')['reservation'], 'admission')
        with self.assertRaises(Hold): self.admit(2, limit=1)

    def test_resource_binding_idempotence_and_actor_workspace_branch_identity(self):
        self.admit(); first = self.bind()
        self.assertEqual(first, self.bind())
        for actor, run, path, branch in [('qa','dev-1',self.root/'dev-1','branch-1'), ('dev','other',self.root/'dev-1','branch-1'), ('dev','dev-1',self.root,'branch-1'), ('dev','dev-1',self.root/'dev-1','changed')]:
            with self.assertRaises(Hold): self.cap.bind('PIT-1', actor, run, path, branch)
        self.admit(2)
        with self.assertRaises(Hold): self.cap.bind('PIT-2','dev','dev-2',self.root/'dev-1','branch-2')
        path=self.root/'dev-2'; path.mkdir()
        with self.assertRaises(Hold): self.cap.bind('PIT-2','dev','dev-2',path,'branch-1')

    def test_controlled_check_environment_separates_every_resource(self):
        results=[]
        for n in (1,2):
            self.admit(n); native=self.root/f'native{n}'; native.mkdir()
            check=native/'.pipeline-artifact'/f'check{n}'; check.mkdir(parents=True)
            env=self.cap.environment(f'PIT-{n}', 'dev', f'run{n}', native, f'branch{n}', check)
            results.append(env)
            self.assertIn('127.0.0.1', env['DATABASE_URL'])
            self.assertEqual(env['DATABASE_URL'], env['PITCHROOM_TEST_DATABASE_URL'])
            self.assertTrue(Path(env['PITCHROOM_BUILD_OUTPUT']).is_relative_to(check))
        for key in results[0]: self.assertNotEqual(results[0][key], results[1][key], key)

    def test_checkout_escape_symlink_and_rebinding_hold(self):
        self.admit(); native=self.root/'native'; native.mkdir()
        outside=self.root/'outside'; outside.mkdir()
        with self.assertRaises(Hold): self.cap.environment('PIT-1','dev','run',native,'branch',outside)
        link=native/'link'; link.symlink_to(outside,target_is_directory=True)
        with self.assertRaises(Hold): self.cap.environment('PIT-1','dev','run',native,'branch',link)

    def test_handoff_reserves_machine_slot_and_rejects_live_predecessor(self):
        self.admit(); self.bind()
        live=observed(); live['runs']=[{'id':'dev-1','issue_id':'id-1'}]
        with self.assertRaises(Hold): self.cap.reserve_run('PIT-1','review','reviewer',live)
        with self.assertRaises(Hold): self.cap.reserve_run('PIT-1','review','reviewer',observed(5))
        self.cap.reserve_run('PIT-1','review','reviewer',observed(4))
        with self.assertRaises(Hold): self.cap.admit(issue(2),BASE,observed(4),2)
        path=self.root/'review'; path.mkdir()
        value=self.cap.bind('PIT-1','reviewer','review-run',path,'review-branch')
        self.assertEqual(value['lease_id'],self.cap.get('PIT-1')['lease_id'])

    def test_single_integration_race_persistent_idempotent_completion(self):
        self.cap.claim_integration('PIT-1',HEAD,BASE,TREE)
        self.cap.close(); self.cap=Capacity(self.state)
        self.cap.claim_integration('PIT-1',HEAD,BASE,TREE)
        with self.assertRaises(Hold): self.cap.claim_integration('PIT-2','e'*40,BASE,TREE)
        with self.assertRaises(Hold): self.cap.complete_integration('PIT-1',HEAD,'e'*40,TREE,MERGE)
        self.cap.complete_integration('PIT-1',HEAD,BASE,TREE,MERGE)
        self.cap.claim_integration('PIT-2','e'*40,MERGE,TREE)
        self.cap.complete_integration('PIT-1',HEAD,BASE,TREE,MERGE)
        self.assertEqual(read_status(self.state)['integration']['issue'],'PIT-2')
        with self.assertRaises(Hold): self.cap.complete_integration('PIT-1',HEAD,BASE,TREE,'e'*40)

    def test_concurrent_integration_claims_have_one_owner(self):
        def claim(n):
            cap=Capacity(self.state)
            try:
                cap.claim_integration(f'PIT-{n}',str(n)*40,BASE,TREE);return 'owner'
            except Hold:return 'held'
            finally:cap.close()
        with ThreadPoolExecutor(max_workers=2) as pool:
            self.assertEqual(sorted(pool.map(claim,(1,2))),['held','owner'])

    def test_retirement_needs_identity_idle_durable_proof_and_preserves_files(self):
        lease=self.admit(); resource=self.root/'dev-1'; self.bind(); (resource/'source').write_text('preserved')
        proof={'merge':MERGE,'evidence':['immutable manifest']}
        for identity, obs, evidence in [('wrong',observed(),proof),(lease['lease_id'],observed(runs=[{'id':'run','issue_id':'id-1'}]),proof),(lease['lease_id'],observed(),{})]:
            with self.assertRaises(Hold): self.cap.retire('PIT-1',identity,obs,evidence)
        self.cap.claim_integration('PIT-1',HEAD,BASE,TREE)
        with self.assertRaises(Hold): self.cap.retire('PIT-1',lease['lease_id'],observed(),proof)
        self.cap.complete_integration('PIT-1',HEAD,BASE,TREE,MERGE)
        self.assertEqual(self.cap.retire('PIT-1',lease['lease_id'],observed(),proof)['deleted_files'],[])
        self.assertEqual((resource/'source').read_text(),'preserved')
        self.admit(2)
        with self.assertRaises(Hold): self.cap.bind('PIT-2','dev','next',resource,'next')
        with self.assertRaises(Hold): self.admit(1)

    def test_read_only_status_never_changes_database_or_creates_sidecars(self):
        self.admit(); before={p.name:p.read_bytes() for p in self.state.iterdir() if p.is_file()}
        self.assertEqual(len(read_status(self.state)['leases']),1)
        self.assertEqual(before,{p.name:p.read_bytes() for p in self.state.iterdir() if p.is_file()})
        (self.state/'capacity.sqlite3-journal').write_text('uncertain')
        with self.assertRaises(Hold): read_status(self.state)

    def test_corrupt_lease_never_reports_known_capacity(self):
        self.admit()
        self.cap.db.execute("UPDATE leases SET data='{}'");self.cap.db.commit()
        with self.assertRaises(Hold): read_status(self.state)
        with self.assertRaises(Hold): self.admit(2)

    def test_parallel_missing_falsey_stale_and_wrong_authority_refused(self):
        self.assertEqual(authorized_lanes(self.root,self.state,1,'fp'),1)
        for grant in (None,{}, {'lanes':2,'source_fingerprint':'fp','approval_reference':'x','authority':'schedule'}, {'lanes':2,'source_fingerprint':'old','approval_reference':'x','authority':'direct_human_parallel_activation'}, {'lanes':2,'source_fingerprint':'fp','approval_reference':'','authority':'direct_human_parallel_activation'}):
            if grant is not None: (self.state/'parallel-authorization.json').write_text(json.dumps(grant))
            with self.assertRaises(Hold): authorized_lanes(self.root,self.state,2,'fp')
        grant={'lanes':2,'source_fingerprint':'fp','approval_reference':'synthetic-human','authority':'direct_human_parallel_activation'}
        (self.state/'parallel-authorization.json').write_text(json.dumps(grant))
        self.assertEqual(authorized_lanes(self.root,self.state,2,'fp'),2)
        for lanes in (True,2.0,3):
            with self.assertRaises(Hold): authorized_lanes(self.root,self.state,lanes,'fp')


class InventoryTests(unittest.TestCase):
    def setUp(self):
        self.runtimes=[{'id':'runtime','daemon_id':'machine','status':'online','last_seen_at':datetime.now(timezone.utc).isoformat()}]
        self.rows=[{'id':f'id-{n}','project_id':'other-project'} for n in range(101)]
        self.runs={'id-100':[{'id':'run','issue_id':'id-100','agent_id':'actor','runtime_id':'runtime','status':'running'}]}
        self.calls=[]
    def call(self,args):
        self.calls.append(args)
        if args[:2]==['runtime','list']: return self.runtimes
        if args[:2]==['issue','list']:
            offset=int(args[args.index('--offset')+1]); return {'issues':self.rows[offset:offset+100],'has_more':offset+100<len(self.rows)}
        return self.runs.get(args[2],[])
    def test_all_workspace_projects_and_pages_count(self):
        result=inventory(self.call,'machine'); self.assertEqual(len(result['runs']),1)
        self.assertTrue(all('--project' not in a for a in self.calls))
        self.assertIn('id-100',[a[2] for a in self.calls if a[:2]==['issue','runs']])
    def test_stale_offline_and_unknown_active_runtime_hold(self):
        self.runtimes[0]['status']='offline'
        with self.assertRaises(Hold): inventory(self.call,'machine')
        self.runtimes[0]['status']='online';self.runtimes[0]['last_seen_at']='2000-01-01T00:00:00Z'
        with self.assertRaises(Hold): inventory(self.call,'machine')
        self.runtimes[0]['last_seen_at']=datetime.now(timezone.utc).isoformat();self.runs['id-100'][0]['runtime_id']='unknown'
        with self.assertRaises(Hold): inventory(self.call,'machine')
    def test_incomplete_duplicates_and_unknown_history_hold(self):
        self.rows[-1]=self.rows[0]
        with self.assertRaises(Hold): inventory(self.call,'machine')
        self.rows=self.rows[:1];self.runs={'id-0':[{'id':'run','issue_id':'id-0','status':'mystery'}]}
        with self.assertRaises(Hold): inventory(self.call,'machine')


class WiredCapacityTests(core.Tests):
    """Run actual Serial dispatch with synthetic native tracker and real Git/SQLite."""
    # Only explicitly defined tests; inherited core tests stay in their own suite.
    def setUp(self):
        super().setUp(); self.ctl.close()
        self.g('branch','-M','main')
        self.c.update(owner='human', capacity={'machine_daemon_id':'machine','port_base':43100})
        self.fake.rows=[issue(1),issue(2)]
        self.ctl=serial.Serial(self.c,self.fake,self.root/'state',None,{'dispatch_control_default':'open'})
        self.ctl.github=type('Remote',(),{'api':lambda _,p:{'sha':self.g('rev-parse','HEAD')},'ci':lambda *a:{'state':'success'}})()
        self.ctl.observation={'deadline_monotonic':time.monotonic()+120}
        self.ctl.machine_inventory=lambda:observed()
        self.ctl.lane_limit=lambda:2
    def test_wired_independent_admission_duplicate_and_conflict(self):
        self.assertEqual(self.ctl.dispatch(True)['started'],['PIT-1','PIT-2'])
        self.assertEqual(len(self.ctl.capacity.leases()),2)
        self.assertEqual(self.ctl.dispatch(True)['started'],[])
    def test_wired_dependency_and_shared_conflict_do_not_start(self):
        self.fake.rows[1]['metadata']['depends_on']='["PIT-1"]'
        self.assertEqual(self.ctl.dispatch(True)['started'],['PIT-1'])
        self.assertEqual(len(self.ctl.capacity.leases()),1)
    def test_wired_scope_overlap_does_not_start_second(self):
        self.fake.rows[1]['metadata']['capacity_scope']=copy.deepcopy(self.fake.rows[0]['metadata']['capacity_scope'])
        self.assertEqual(self.ctl.dispatch(True)['started'],['PIT-1'])
    def test_wired_uncertain_enqueue_reopen_does_not_repeat(self):
        self.fake.fail_update=True
        with self.assertRaises(TimeoutError): self.ctl.dispatch(True)
        writes=len(self.fake.writes); self.assertEqual(len(self.ctl.capacity.leases()),1)
        self.fake.fail_update=False
        with self.assertRaises(Hold): self.ctl.dispatch(True)
        self.assertEqual(len(self.fake.writes),writes)
    def test_wired_check_environment_reaches_real_child_process(self):
        self.ctl.dispatch(True)
        native = self.root/'native'; self.g('worktree','add','-qb','native-branch',str(native),'HEAD')
        checkout = native/'.pipeline-artifact'/'check'; checkout.mkdir(parents=True)
        with self.runtime('developer', native, 'actual-run'):
            self.ctl.current('PIT-1','developer')
            env = self.ctl.check_environment(self.ctl.lanes()['PIT-1'], 'developer', checkout, 'actual-run')
            child = subprocess.check_output([sys.executable,'-B','-c','import os,json;print(json.dumps(dict(os.environ)))'], env=env, text=True)
        actual = json.loads(child)
        for key, value in env.items(): self.assertEqual(actual[key], value)
        self.assertNotIn('OPENAI_API_KEY', actual)
        self.assertNotEqual(actual['DATABASE_URL'], 'personal database')

    def test_wired_machine_limit_blocks_remote_mutation(self):
        self.ctl.machine_inventory = lambda: observed(5)
        result = self.ctl.dispatch(True)
        self.assertEqual(result['started'], [])
        self.assertEqual(self.fake.writes, [])
        self.assertEqual(self.ctl.capacity.leases(), {})

    def test_main_advance_invalidates_old_passing_artifact(self):
        base=self.g('rev-parse','HEAD');lane={'artifact':{'commit':base},'compatibility_base':base}
        self.ctl.compatibility(lane,base)
        (self.repo/'second').write_text('other task');self.g('add','second');self.g('commit','-qm','other integration')
        with self.assertRaisesRegex(Hold,'Main changed'): self.ctl.compatibility(lane,self.g('rev-parse','HEAD'))
    def test_done_retirement_checks_actual_source_and_evidence_before_reusing_slot(self):
        self.ctl.dispatch(True)
        native=self.root/'bound';native.mkdir()
        self.ctl.capacity.bind('PIT-1','dev','dev-run',native,'native-branch')
        base=self.g('rev-parse','HEAD');(self.repo/'merged').write_text('durable')
        self.g('add','merged');self.g('commit','-qm','delivered');head=self.g('rev-parse','HEAD')
        merge=self.g('commit-tree',self.g('rev-parse','HEAD^{tree}'),'-p',base,'-m','squash')
        lane=self.ctl.lanes()['PIT-1'];lane.update(phase='done',merge_approval={'head':head,'base':base},integration={'commit':merge},receipts={},contract={'checks':{'unit':{}}})
        for role in ('developer','reviewer','qa'):
            binding={'issue':'PIT-1','generation':1,'role':role,'actor_id':self.c[role],'run_id':role+'-run','commit':head,'contract_sha256':'c'*64,'description_sha256':lane['description_sha256']}
            root=self.ctl.root/'role-evidence'/'PIT-1'/'1'/role/binding['run_id'];root.mkdir(parents=True)
            (root/'intent.json').write_text('{}');(root/'manifest.json').write_text(json.dumps({'complete':True,'binding':binding,'files':[]}))
            lane['receipts'][role]={**binding,'retained_evidence':str(root/'manifest.json')}
            checks=self.ctl.root/'evidence'/'PIT-1'/'1'/role/binding['run_id']
            (checks/'checks').mkdir(parents=True);(checks/'logs').mkdir()
            (checks/'checks/unit.json').write_text(json.dumps({'commit':head,'generation':1,'assertion_passed':True,'stdout_sha256':hashlib.sha256(b'pass').hexdigest()}))
            (checks/'logs/unit.stdout').write_text('pass');(checks/'logs/unit.stderr').write_text('')
        self.fake.rows[0]['status']='done';self.ctl.save(lane)
        qa=Path(lane['receipts']['qa']['retained_evidence']);valid=qa.read_text();qa.write_text('{}')
        with self.assertRaises(Hold): self.ctl.retire_capacity('PIT-1',lane['capacity_lease'],automatic=True)
        self.assertIn('PIT-1',self.ctl.capacity.leases())
        qa.write_text(valid)
        result=self.ctl.retire_capacity('PIT-1',lane['capacity_lease'],automatic=True)
        self.assertTrue(result['retired']);self.assertTrue(qa.exists());self.assertTrue(native.exists())
        self.assertNotIn('PIT-1',self.ctl.capacity.leases())

    def test_pause_leaves_owned_leases_and_resume_never_redispatches(self):
        self.ctl.dispatch(True); before=self.ctl.capacity.leases(); writes=len(self.fake.writes)
        with patch.object(serial,'control_state',return_value={'mode':'admission_paused'}): self.ctl.dispatch(True)
        self.assertEqual(self.ctl.capacity.leases(),before);self.assertEqual(len(self.fake.writes),writes)
        with patch.object(serial,'control_state',return_value={'mode':'maintenance'}):
            self.assertIn('held',self.ctl.tick(True))
        self.assertEqual(self.ctl.dispatch(True)['started'],[])

# Reuse fixture helpers without executing unrelated inherited tests twice.
for _name in list(vars(core.Tests)):
    if _name.startswith('test_') and _name not in vars(WiredCapacityTests):
        setattr(WiredCapacityTests,_name,None)
