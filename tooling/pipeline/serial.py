#!/usr/bin/env python3
"""Canonical single-lane polling controller. No automatic merge or deployment."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import time

from controller import Controller, Hold, RUNNING, ACTIVE, digest, git, lock, write_json
from artifacts import ArtifactError, verify_squash_merge, _path, checkpoint, has_ancestor, materialize, prepare_dependencies, verify_clean_tree
from github_sync import GitHub, SyncError, all_issues, cli, sync, invalidate

SOURCE = Path(__file__).resolve().parents[2]


def canonical(root=SOURCE):
    return Path(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir')).parent


def fingerprint(root):
    digestor = hashlib.sha256()
    for name in ('serial.py', 'controller.py', 'acceptance.py', 'artifacts.py', 'github_sync.py', 'runtime.json', 'policy.json'):
        digestor.update(name.encode() + b'\0' + (Path(root) / 'tooling/pipeline' / name).read_bytes())
    return digestor.hexdigest()


def configured(root):
    value = json.loads((root / 'tooling/pipeline/runtime.json').read_text())
    value['repository'] = str(root)
    return value


class Serial(Controller):
    def __init__(self, config, call, state, github, policy, execute=cli):
        self.raw_call=call
        def checked_call(argv):
            if argv[:2]==['issue','update'] and '--status' in argv:
                self.require_fresh()
            return call(argv)
        super().__init__(config, checked_call, state)
        self.github, self.policy, self.execute = github, policy, execute
        self.observation = None

    def issues(self):
        return all_issues(self.call, self.c['project'])

    def require_enabled(self):
        path = self.root / 'activation.json'
        if not path.exists():
            raise Hold('Runtime not activated; sync alone is allowed')
        value = json.loads(path.read_text())
        if value.get('source_fingerprint') != fingerprint(self.c['repository']) or value.get('task_lanes') != 1 or value.get('verified') is not True:
            raise Hold('Activation stale or unverified; no scheduling')

    def require_fresh(self):
        if not self.observation or time.monotonic()>=self.observation.get('deadline_monotonic',0):
            if self.observation:invalidate(self.raw_call,self.observation.get('issues',{}))
            write_json(self.root/'sync-health.json',{'state':'unavailable','error':'Observation missing/expired before transition'})
            raise Hold('Fresh observation expired; no transition')

    def refresh(self, apply):
        previous=json.loads((self.root/'github-latest.json').read_text()) if (self.root/'github-latest.json').exists() else {}
        try:
            self.observation=sync(self.policy,self.call,self.github,apply,previous=previous)
        except SyncError:
            write_json(self.root/'sync-health.json',{'state':'unavailable','error':'Source reads/publication incomplete'})
            raise
        if apply:
            write_json(self.root/'github-latest.json',self.observation)
            write_json(self.root/'sync-health.json',{'state':'fresh','observed_at':self.observation['observed_at']})
        return self.observation

    def publish_checkpoint(self, lane, workdir, key):
        # Publish only declared source on integrated main. Native runtime commits,
        # managed AGENTS blocks and private runtime history are never exported.
        workdir = Path(workdir).resolve()
        repo = Path(self.c['repository']).resolve()
        main = git(repo, 'rev-parse', 'HEAD')
        base = lane.get('rework_public_commit', main)
        if git(repo, 'branch', '--show-current') != 'main' or git(repo, 'status', '--porcelain'):
            raise Hold('Canonical main must be clean')
        if not has_ancestor(repo, main, base) or not has_ancestor(repo, main, git(workdir, 'rev-parse', 'HEAD')):
            raise Hold('Developer base is stale; explicit integration required')
        dest = Path(workdir) / '.pipeline-artifact' / f'publish-{key}-g{lane["generation"]}'
        dest.parent.mkdir(parents=True, exist_ok=True)
        materialize(repo, base, dest)
        paths = lane['contract']['allowed_paths']
        for name in paths:
            _path(Path(workdir), name)
            if name == 'AGENTS.md':
                raise Hold('Automatic delivery cannot export runtime/governance instructions')
            source, target = Path(workdir) / name, dest / name
            if source.exists():
                if source.stat().st_size > 2000000:
                    raise Hold('Oversized task source')
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, target)
            elif target.exists():
                target.unlink()
        commit = checkpoint(dest, key, lane['generation'], paths, repository=repo)
        copied = prepare_dependencies(repo, dest)
        if copied['sha256'] != lane['dependencies']['sha256']:
            raise Hold('Dependency identity changed before publication')
        lane['published_checkout'] = str(dest)
        lane['native_head'] = git(workdir, 'rev-parse', 'HEAD')
        return commit

    def publish_pr(self, lane):
        artifact = lane['artifact']; key = lane['issue']
        branch = lane.get('rework_branch') or 'codex/' + key.lower() + '-delivery-g' + str(lane['generation'])
        existing=lane.get('rework_pr_number')
        if existing:
            pr=self.github.api('pulls/'+str(existing))
            if pr['state']!='open' or pr['base']['ref']!='main' or pr['head']['sha']!=lane['rework_public_commit'] or pr['head']['ref']!=branch:
                raise Hold('Original PR changed/closed; no automatic replacement')
        token = 'publish:' + key + ':' + str(lane['generation'])
        self.reserve(token)
        root = Path(self.c['repository'])
        subprocess.run(['git', '-C', str(root), 'push', 'origin', artifact['commit'] + ':refs/heads/' + branch], check=True, capture_output=True, timeout=90)
        if existing:
            url='https://github.com/'+self.policy['repository']+'/pull/'+str(existing)
        else:
            body = Path.cwd() / '.pipeline-local' / 'pr-body.md'; body.parent.mkdir(exist_ok=True)
            body.write_text(f'{key}: scoped engineering artifact {artifact["commit"]}.\n\nLocal contract checks completed. Independent review/QA pending. No merge or deployment. Full acceptance remains on the original issue.\n')
            p = subprocess.run(['gh', 'pr', 'create', '--repo', self.policy['repository'], '--draft', '--base', 'main', '--head', branch, '--title', key + ': scoped delivery', '--body-file', str(body)], cwd=Path.cwd(), capture_output=True, text=True, timeout=90)
            if p.returncode:
                raise Hold('PR publication uncertain; inspect remote before any replay')
            url = p.stdout.strip()
        expected = 'https://github.com/' + self.policy['repository'] + '/pull/'
        if not url.startswith(expected) or not url[len(expected):].isdigit():
            raise Hold('Unexpected PR identity')
        lane['pr_number'], lane['branch'] = int(url[len(expected):]), branch
        self.save(lane); self.finish(token)
        for name, value in {'pr_url':url,'pr_number':str(lane['pr_number']),'artifact_sha':artifact['commit']}.items():
            self.call(['issue','metadata','set',lane['id'],'--key',name,'--value',value])

    def transition(self, lane, issue, target, report):
        # Role submits, then exits; scheduler makes the transition only afterwards.
        role = lane['phase']
        if role not in ('developer','reviewer','qa'):
            raise Hold('Only active role can queue a transition')
        actor, run = self.actor(role)
        pending = {'target': 'in_review' if role == 'qa' and target == 'done' else target,
                   'role':role,'run':run,'actor':actor,'issue_status':issue['status'],
                   'assignee':issue.get('assignee_id'),'report':str(Path(report).resolve()),
                   'source_description':lane['description_sha256'],'engineering_verified':role=='qa' and target=='done'}
        if role == 'developer' and target == self.c['review_status']:
            self.publish_pr(lane)
        lane['pending'] = pending
        self.save(lane)

    def stage(self, key, role, report, workdir):
        result = super().stage(key, role, report, workdir)
        lane = self.lanes()[key]
        lane['phase'] = 'awaiting_role_exit'
        self.save(lane)
        result['status'] = 'queued_until_runtime_exit'
        return result

    def return_to_owner(self, key, role, report, rework=False):
        lane, issue = self.current(key, role)
        note=json.loads(Path(report).read_text())
        if not note.get('gaps') and not note.get('decisions'):raise Hold('Concrete gap/decision required')
        repair=rework and role in ('reviewer','qa') and lane['repairs']<2
        path=self.root/'returns'/f'{key}-g{lane["generation"]}-{role}.json';write_json(path,note)
        self.transition(lane,issue,'todo' if repair else 'in_review',path)
        lane['pending']['rework']=repair;lane['phase']='awaiting_role_exit';self.save(lane)
        return {'issue':key,'status':'queued_until_runtime_exit'}

    def workspace(self, key, workdir):
        lane,_=self.current(key,'developer')
        if lane.get('rework_public_commit') and not lane.get('developer_workspace'):
            for name in lane['rework_paths']:
                _path(Path(workdir),name)
                prior=subprocess.run(['git','-C',self.c['repository'],'show',lane['rework_public_commit']+':'+name],capture_output=True)
                source=Path(workdir)/name
                if (prior.returncode==0 and (not source.exists() or source.read_bytes()!=prior.stdout)) or (prior.returncode!=0 and source.exists()):
                    raise Hold('Rework native source does not preserve prior public delivery; explicit recovery required')
        return super().workspace(key,workdir)

    def _transition(self, lane, issue, target, report):
        token='transition:'+lane['issue']+':'+str(lane['generation'])+':'+lane['phase']
        self.reserve(token)
        fresh=self.issue(lane['issue'])
        if fresh['status']!=issue['status'] or fresh.get('assignee_id')!=issue.get('assignee_id') or digest(fresh.get('description') or '')!=lane['description_sha256']:
            raise Hold('Issue changed before transition')
        self.dependencies(fresh,self.issues(),lane.get('artifact',{}).get('commit'))
        # Metadata is inert. Do not comment/mention an old handler during handoff.
        self.call(['issue','metadata','set',lane['id'],'--key','pipeline_status','--value',target])
        role={self.c['review_status']:'reviewer',self.c['qa_status']:'qa','todo':'developer'}.get(target)
        args=['issue','update',lane['id'],'--status',target,'--assignee-id',self.c[role] if role else self.c['owner'],'--output','json']
        if not role:args+=['--no-start']
        pending=lane['pending']
        next_lane=json.loads(json.dumps(lane));next_lane.pop('pending')
        if pending['engineering_verified']:next_lane['phase']='awaiting_merge'
        elif target==self.c['review_status']:next_lane['phase']='reviewer'
        elif target==self.c['qa_status']:next_lane['phase']='qa'
        elif target=='todo':
            next_lane.update(phase='developer',generation=lane['generation']+1,repairs=lane['repairs']+1,
                             rework_base_commit=lane['native_head'],rework_public_commit=lane['artifact']['commit'],rework_paths=lane['contract']['allowed_paths'],
                             rework_pr_number=lane.get('pr_number'),rework_branch=lane.get('branch'))
            for name in ('artifact','receipts','checkouts','contract','developer_workspace','dependencies','published_checkout','pr_number','branch'):
                next_lane.pop(name,None)
        else:next_lane['phase']='held'
        self.save(next_lane)  # A newly started runtime must see its own stage already published.
        self.call(args);self.finish(token)

    def pr_for(self, lane):
        self.require_fresh()
        rows = self.observation['issues'].get(lane['issue'], {}).get('prs', [])
        matches = [x for x in rows if x['number']==lane.get('pr_number') and x['head']==lane.get('artifact',{}).get('commit')]
        if len(matches)!=1:
            raise Hold('Exact artifact PR missing or head changed')
        return matches[0]

    def record_merge_approval(self, key, approved_head):
        if os.environ.get('MULTICA_TASK_ID'):raise Hold('Merge approval recording is an explicit human operator action')
        lane=self.lanes().get(key)
        if not lane or lane['phase']!='awaiting_merge':raise Hold('Task is not waiting for an approved merge')
        if lane['artifact']['commit']!=approved_head:raise Hold('Human-approved head differs from the reviewed artifact')
        pr=self.pr_for(lane)
        if pr['state']!='OPEN' or pr.get('base')!='main' or pr.get('ci',{}).get('state')!='success':raise Hold('Approved PR must target main, be ready and current-head CI successful')
        base=self.github.api('commits/main')['sha']
        if self.github.ci(base,'push')['state']!='success':raise Hold('Current pre-merge main CI must pass')
        intent={'method':'squash','head':approved_head,'base':base,'pr_number':pr['number']}
        if lane.get('merge_approval') and lane['merge_approval']!=intent:raise Hold('Merge intent changed; explicit operator reconciliation required')
        lane['merge_approval']=intent;self.save(lane)
        return intent

    def drain(self, apply):
        results=[]
        for lane in self.lanes().values():
            if lane['phase']=='awaiting_merge':
                pr=self.pr_for(lane)
                if pr['state']!='MERGED' or pr.get('integration_ci',{}).get('state')!='success':
                    results.append({'issue':lane['issue'],'waiting':'human merge and post-merge CI'});continue
                self.require_fresh()
                remote=self.github.api('commits/main')['sha']
                # Post-merge result belongs to actual merge commit; no obsolete main acceptance.
                if remote!=pr['merge_sha']:
                    raise Hold('Main moved after delivery merge; explicit integration verification required')
                repo=self.c['repository']
                if self.policy.get('merge_policy') != 'human_approved_squash':raise Hold('Explicit squash merge policy required')
                if apply:
                    subprocess.run(['git','-C',repo,'fetch','origin','main'],check=True,capture_output=True,timeout=90)
                intent=lane.get('merge_approval')
                if not intent or intent.get('method')!='squash' or intent.get('head')!=lane['artifact']['commit'] or intent.get('pr_number')!=pr['number']:
                    raise Hold('Recorded human-approved pre-merge base is missing or differs')
                integration=verify_squash_merge(repo,lane['artifact']['commit'],remote,intent['base'])
                if not apply:results.append({'issue':lane['issue'],'would_complete':True,'integration':integration});continue
                if git(repo,'status','--porcelain') or git(repo,'branch','--show-current')!='main':raise Hold('Canonical checkout not clean main')
                subprocess.run(['git','-C',repo,'merge','--ff-only','origin/main'],check=True,capture_output=True,timeout=45)
                self.reserve('complete:'+lane['issue']+':'+str(lane['generation']))
                issue=self.issue(lane['issue'])
                if digest(issue.get('description') or '')!=lane['description_sha256'] or issue['status']!='in_review':raise Hold('Contract/status changed before completion')
                self.call(['issue','update',lane['id'],'--status','done','--no-start','--output','json'])
                self.finish('complete:'+lane['issue']+':'+str(lane['generation']));lane['integration']=integration;lane['phase']='done';self.save(lane)
                results.append({'issue':lane['issue'],'status':'done'});continue
            pending=lane.get('pending')
            if not pending:continue
            runs=self.call(['issue','runs',lane['id'],'--output','json'])
            match=[r for r in runs if r['id']==pending['run'] and r['agent_id']==pending['actor']]
            if len(match)!=1 or match[0]['status']!='completed':
                results.append({'issue':lane['issue'],'waiting':'preceding runtime not successfully terminal'});continue
            issue=self.issue(lane['issue'])
            if issue['status']!=pending['issue_status'] or issue.get('assignee_id')!=pending['assignee'] or digest(issue.get('description') or '')!=pending['source_description']:
                raise Hold('Issue/owner/contract changed while role exited')
            if lane.get('pr_number') and pending['target'] not in ('in_review','todo'):
                pr=self.pr_for(lane)
                if pr['state'] not in ('OPEN','DRAFT') or pr.get('base')!='main':
                    raise Hold('Forward handoff requires active PR on main')
                if pr['ci']['state']!='success' and pending['target']!='in_review':
                    results.append({'issue':lane['issue'],'waiting':'exact-head CI not successful'});continue
            if not apply:results.append({'issue':lane['issue'],'would_transition':pending['target']});continue
            # Preserve old phase in durable transition identity; never replay uncertain writes.
            lane['phase']='exit-'+pending['role']+'-g'+str(lane['generation'])
            self._transition(lane,issue,pending['target'],pending['report'])
            results.append({'issue':lane['issue'],'status':pending['target']})
        return results

    def retry_qa(self, key, head, reason):
        if os.environ.get('MULTICA_TASK_ID'):
            raise Hold('QA resubmission requires an explicit operator')
        self.require_fresh()
        if not reason.strip():raise Hold('Concrete report-reconciliation reason required')
        if self.db.execute("SELECT 1 FROM operations WHERE state='uncertain'").fetchone():
            raise Hold('Uncertain operation requires reconciliation')
        lane=self.lanes().get(key)
        if not lane or lane['phase']!='held':
            raise Hold('Only held QA evidence may be reassessed')
        previous=lane.get('receipts',{}).get('qa',{})
        if lane.get('pending') and (lane['pending']['role']!='qa' or lane['pending']['engineering_verified']):
            raise Hold('QA is not held for evidence reconciliation')
        if not previous.get('gaps') or previous.get('outcome')!='pass':
            raise Hold('Source defects require original-task rework')
        if head!=lane.get('artifact',{}).get('commit') or previous.get('commit')!=head:
            raise Hold('Reassessment must keep the identical artifact')
        if lane.get('qa_retries',0)>=1:raise Hold('QA evidence retry limit reached')
        issue=self.issue(key)
        if issue['status'] not in ('in_review','blocked'):
            raise Hold('QA hold must be acknowledged by the scheduler')
        if digest(issue.get('description') or '')!=lane['description_sha256']:
            raise Hold('Original contract changed')
        rows=self.issues()
        if self.active_issues(rows)-{key}:raise Hold('Another runtime owns capacity')
        runs=self.call(['issue','runs',lane['id'],'--output','json'])
        if not isinstance(runs,list) or any(not isinstance(r,dict) or (not isinstance(r.get('id'),str) or r.get('status') not in RUNNING | {'completed','failed','cancelled'}) for r in runs):
            raise Hold('Unknown QA runtime history')
        if any(r['status'] in RUNNING for r in runs):
            raise Hold('Target issue still has a live runtime')
        if not any(r['id']==previous.get('run_id') and r.get('agent_id')==self.c['qa'] and r['status']=='completed' for r in runs):
            raise Hold('Prior independent QA is not terminal')
        pr=self.pr_for(lane)
        if pr['state'] not in ('OPEN','DRAFT') or pr['base']!='main' or pr['ci']['state']!='success':
            raise Hold('Active exact-head PR CI required')
        token='retry-qa:'+key+':'+str(lane['generation'])+':'+head
        self.reserve(token)
        path=self.root/'qa-retries'/f'{key}-g{lane["generation"]}.json'
        if path.exists():raise Hold('Prior retry evidence exists; reconcile without replay')
        write_json(path,{'original_lane':lane,'reason':reason,'artifact':head,'prior_run':previous['run_id']})
        next_lane=json.loads(json.dumps(lane));next_lane.pop('pending',None)
        next_lane.get('receipts',{}).pop('qa',None);next_lane.get('checkouts',{}).pop('qa',None)
        next_lane.update(phase='qa',qa_retries=1)
        self.save(next_lane)
        self.call(['issue','update',lane['id'],'--status',self.c['qa_status'],'--assignee-id',self.c['qa'],'--output','json'])
        self.finish(token)
        return {'issue':key,'status':self.c['qa_status'],'artifact':head,'qa_retries':1,'original_evidence':str(path)}

    def active_issues(self, issues):
        actors = {self.c[role] for role in ('developer', 'reviewer', 'qa')}
        active = {lane['issue'] for lane in self.lanes().values()
                  if lane['phase'] not in ('done', 'held')}
        for issue in issues:
            if issue.get('assignee_id') in actors and issue['status'] in ACTIVE:
                active.add(issue['identifier'])
            # Runtime ownership may outlive assignment/status. Inspect every
            # issue, including human-owned and unassigned legacy records.
            runs = self.call(['issue', 'runs', issue['id'], '--output', 'json'])
            if not isinstance(runs, list) or any(not isinstance(run, dict) or run.get('status') not in RUNNING | {'completed', 'failed', 'cancelled'} for run in runs):
                raise Hold('Unknown runtime history; no scheduling')
            if any(run['status'] in RUNNING for run in runs):
                active.add(issue['identifier'])
        return active

    def dispatch(self, apply=False):
        active=[x['issue'] for x in self.lanes().values() if x['phase'] not in ('done','held')]
        if active:return {'active':active,'started':[],'held':{'single_lane':'Existing artifact owns the lane through merge'}}
        self.require_fresh()
        remote=self.github.api('commits/main')['sha']
        if git(self.c['repository'],'rev-parse','HEAD')!=remote or git(self.c['repository'],'status','--porcelain') or git(self.c['repository'],'branch','--show-current')!='main':
            raise Hold('Canonical main is stale or dirty; no new task')
        if self.github.ci(remote,'push')['state']!='success':raise Hold('Current main CI not successful')
        return super().dispatch(apply)

    def tick(self, apply=False):
        self.refresh(apply)
        if self.db.execute("SELECT 1 FROM operations WHERE state='uncertain'").fetchone():raise Hold('Uncertain write requires explicit reconciliation')
        if apply:self.require_enabled()
        transitions=self.drain(apply)
        return {'transitions':transitions,'dispatch':self.dispatch(apply),'sync':{'observed_at':self.observation['observed_at'],'writes':self.observation['writes']}}


def activate(root, config, state, github, call, receipt_path):
    if os.environ.get('MULTICA_TASK_ID'):
        raise Hold('Activation is an explicit operator action, never an Agent role action')
    receipt=json.loads(Path(receipt_path).read_text())
    if receipt.get('authority')!='direct_human_domain_free_serial_2026-10-27':raise Hold('Explicit activation authority required')
    head=git(root,'rev-parse','HEAD')
    if git(root,'branch','--show-current')!='main' or git(root,'status','--porcelain') or github.api('commits/main')['sha']!=head:
        raise Hold('Activate only clean integrated current main')
    reports=[]
    for role in ('reviewer','qa'):
        path=Path(receipt[role+'_report']).resolve()
        if not path.is_relative_to(root.parent/'.pitchroom-worktrees') and not path.is_relative_to(state):raise Hold('Report outside controlled local evidence roots')
        report=json.loads(path.read_text());sha=report.get('head_sha')
        if report.get('verdict')!='pass' or report.get('role')!=role or not sha:raise Hold('Independent role pass missing')
        if not has_ancestor(root,sha,head):
            matches=[pr for pr in github.api('commits/'+sha+'/pulls') if pr.get('merged_at') and pr.get('head',{}).get('sha')==sha and pr.get('base',{}).get('ref')=='main']
            if len(matches)!=1:raise Hold('Reviewed source has no unique merged PR mapping')
            merged=matches[0]['merge_commit_sha']
            if not has_ancestor(root,merged,head):raise Hold('Reviewed squash integration is absent from main')
            verify_squash_merge(root,sha,merged,receipt.get('reviewed_integration_base',''))
            if github.ci(merged,'push')['state']!='success':raise Hold('Reviewed squash integration CI must pass')
        for name in ('serial.py','controller.py','artifacts.py','acceptance.py','github_sync.py','runtime.json','policy.json'):
            actual=(root/'tooling/pipeline'/name).read_bytes()
            approved=subprocess.check_output(['git','-C',str(root),'show',sha+':tooling/pipeline/'+name])
            if approved!=actual:raise Hold('Controller changed after independent review')
        identity=report.get('identity',{});run_id=identity.get('run_id') or identity.get('task_id')
        runs=call(['issue','runs',receipt['issue'],'--output','json'])
        if not any(r['id']==run_id and r['agent_id']==config[role] and r['status']=='completed' for r in runs):raise Hold('Independent terminal runtime identity missing')
        reports.append((sha,run_id))
    if reports[0][0]!=reports[1][0] or reports[0][1]==reports[1][1]:raise Hold('Role artifact/independence mismatch')
    if github.ci(head,'push')['state']!='success':raise Hold('Integrated main CI must pass before activation')
    if config['max_lanes']!=1:raise Hold('Only one lane authorized')
    for name in ('config.json','config-v2.json'):
        legacy=root.parent/'tooling/multica-pipeline'/name
        if not legacy.exists() or json.loads(legacy.read_text()).get('enabled') is not False:raise Hold('Legacy controls must remain disabled')
    proof={'verified':True,'task_lanes':1,'source_fingerprint':fingerprint(root),'integrated_commit':head,'role_runs':[r[1] for r in reports],'authority':receipt['authority']}
    write_json(state/'activation.json',proof)
    return proof


def main():
    p=argparse.ArgumentParser(description=__doc__);sub=p.add_subparsers(dest='command',required=True)
    q=sub.add_parser('tick');q.add_argument('--apply',action='store_true')
    q=sub.add_parser('activate');q.add_argument('--receipt',type=Path,required=True)
    q=sub.add_parser('approve-merge');q.add_argument('issue');q.add_argument('--approved-head',required=True)
    q=sub.add_parser('retry-qa');q.add_argument('issue');q.add_argument('--head',required=True);q.add_argument('--reason',required=True)
    for name in ('workspace','plan','checkout','stage','return'):
        q=sub.add_parser(name);q.add_argument('issue');q.add_argument('--workdir',type=Path,default=Path.cwd())
        if name in ('checkout','stage','return'):q.add_argument('--role',choices=['developer','reviewer','qa'],required=True)
        if name in ('plan','stage','return'):q.add_argument('--report',type=Path,required=True)
        if name=='return':q.add_argument('--rework',action='store_true')
    args=p.parse_args();root=canonical()
    if SOURCE!=root:raise Hold('Execute the integrated canonical controller, never a task copy')
    config=configured(root);policy=json.loads((root/'tooling/pipeline/policy.json').read_text());state=root/'.state/pipeline'
    def call(a):return cli(['multica','--profile',config['profile'],'--workspace-id',config['workspace'],*a])
    name='controller' if args.command in ('tick','activate','approve-merge','retry-qa') else 'issue-'+args.issue
    if '/' in name or '..' in name:raise Hold('Invalid issue identity')
    with lock(state,name=name,wait=45):
        c=Serial(config,call,state,GitHub(policy['repository']),policy)
        try:
            if args.command=='activate':result=activate(root,config,state,c.github,call,args.receipt)
            elif args.command=='tick':result=c.tick(args.apply)
            elif args.command=='retry-qa':
                c.require_enabled();c.refresh(False);result=c.retry_qa(args.issue,args.head,args.reason)
            elif args.command=='approve-merge':
                c.require_enabled();c.refresh(False);result=c.record_merge_approval(args.issue,args.approved_head)
            else:
                c.require_enabled()
                if args.command=='workspace':result=c.workspace(args.issue,args.workdir)
                elif args.command=='plan':result=c.plan(args.issue,args.report)
                elif args.command=='checkout':result=c.checkout(args.issue,args.role,args.workdir)
                elif args.command=='stage':result=c.stage(args.issue,args.role,args.report,args.workdir)
                else:result=c.return_to_owner(args.issue,args.role,args.report,args.rework)
            print(json.dumps(result,ensure_ascii=False,indent=2))
        finally:c.close()


if __name__=='__main__':
    try:main()
    except (Hold,ArtifactError,SyncError,OSError,ValueError,subprocess.SubprocessError) as error:
        print(json.dumps({'held':str(error)},ensure_ascii=False));raise SystemExit(2)
