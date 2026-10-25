import { isDeepStrictEqual } from "node:util";
import { createModelClarificationRunner, evaluateClarification, classifyClarificationFailure } from "@pitchroom/agent";
import { buildReassessmentContext, sourceFingerprint, type ClarificationTask, type ClarificationFailureDiagnostic } from "@pitchroom/domain";
import { clarifyCases, taskForCase } from "./clarification-cases";
import { gradeClarification } from "./clarification-offline";
import { ClarifyBudget, ClarifyStop, clarifyLimits, deepSeekModelRequestLimit, clarifyLiveConfigSchema, type ClarifyLiveConfig } from "./clarification-budget";
import { codeFingerprint, hash, LocalClarifyRecords } from "./clarification-records";

type Check={name:string;passed:boolean};
type Evaluation=Awaited<ReturnType<typeof evaluateClarification>>;
type Outcome={id:string;caseId:string;status:"generated"|"execution_failed"|"not_run_budget"|"not_run_after_failure"|"blocked";task?:ClarificationTask;output?:Evaluation;outputHash?:string;checks?:Check[];error?:string;failure?:ClarificationFailureDiagnostic;startedAt?:string;elapsedMs?:number};
type Review={outputHash:string;reviewer:string;verdict:"pending"|"pass"|"fail";checks:Record<string,"pending"|"pass"|"fail">;criticalErrors:string[];notes:string};
type Session={phase:"prepared"|"awaiting_case1_review"|"awaiting_chain6_review"|"complete"|"stopped";outcomes:Outcome[];mode:"live-model"|"offline-provider"};
type Manifest={schemaVersion:1;config:ClarifyLiveConfig;limits:typeof clarifyLimits;fingerprint:Record<string,string>;createdAt:string;caseContractHash:string;mode:Session["mode"]};
const reviewKeys=["scope","certainty","bounds","history","nextStep"];
export function initializeClarifySession(records:LocalClarifyRecords,config:ClarifyLiveConfig,mode:Session["mode"]){
 const fingerprint=codeFingerprint();
 const manifest={schemaVersion:1,config:clarifyLiveConfigSchema.parse(config),limits:clarifyLimits,fingerprint,caseContractHash:fingerprint["packages/evals/src/clarification-cases.ts"],createdAt:new Date().toISOString(),mode} satisfies Manifest;
 records.write("manifest.json",manifest,true);
 records.write("session.json",{phase:"prepared",outcomes:[],mode} satisfies Session,true);
 records.write("reviews.json",{},true);
 records.event({type:"session_prepared",manifestHash:hash(manifest),caseContracts:clarifyCases.map(c=>({id:c.id,answer:c.answer,mustChange:c.mustChange,mustPreserve:c.mustPreserve,mustNot:c.mustNot,humanReview:c.humanReview}))});
}
function judgedPass(outcome:Outcome,reviews:Record<string,Review>){
 const r=reviews[outcome.id];return outcome.status==="generated"&&outcome.checks?.every(c=>c.passed)&&r?.outputHash===outcome.outputHash&&r.verdict==="pass"&&typeof r.reviewer==="string"&&r.reviewer.trim().length>0&&reviewKeys.every(k=>r.checks?.[k]==="pass")&&Array.isArray(r.criticalErrors)&&r.criticalErrors.length===0&&typeof r.notes==="string"&&r.notes.trim().length>0;
}
function recordReviewTemplate(records:LocalClarifyRecords,outcome:Outcome){
 if(!outcome.outputHash)return;
 const reviews=records.read<Record<string,Review>>("reviews.json");
 reviews[outcome.id]={outputHash:outcome.outputHash,reviewer:"",verdict:"pending",checks:Object.fromEntries(reviewKeys.map(k=>[k,"pending"])),criticalErrors:[],notes:""};records.write("reviews.json",reviews);
}
export function realCaseTask(caseId:string){
 const task=taskForCase(clarifyCases.find(c=>c.id===caseId)!);
 if(caseId==="CLR-J08"){
  const original=structuredClone(task);
  task.sources.push({id:"client-window",projectId:task.projectId,name:"client-window.md",mediaType:"text/markdown",contentHash:"synthetic-two-weeks",chunks:[{id:"window-chunk",sourceId:"client-window",text:"客户只批准两周窗口。",startOffset:0,endOffset:11}]});
  task.reassessment=buildReassessmentContext(original,task.sources);
  task.id+="-reassessed";task.baseUnderstandingId+="-new-review";task.baseRevision++;task.sourceFingerprint=sourceFingerprint(task.sources);
 }
 return task;
}
function structuralGrade(task:ClarificationTask,snapshot:ClarificationTask,output:Evaluation){
 const c=clarifyCases.find(c=>c.id===task.commandId)!;
 // Same approved rules, applied to the actual input snapshot (including chain inputs).
 const checks=gradeClarification(c,task,output.result,output.candidate).filter(c=>!["base_snapshot_not_mutated","original_claims_preserved","next_question_related_to_target"].includes(c.name));
 checks.unshift({name:"base_snapshot_not_mutated",passed:isDeepStrictEqual(task,snapshot)});
 checks.push({name:"next_question_association_valid",passed:output.candidate.nextQuestion.relatedThemeIndexes.every(i=>Boolean(output.candidate.themes[i]))});
 checks.push({name:"original_claims_preserved",passed:snapshot.base.themes.every((theme,i)=>theme.claims.every((claim,j)=>{
  const next=output.candidate.themes[i]?.claims[j];if(!next)return false;
  // Added correction metadata is allowed; original words, evidence and attribution are immutable.
  const {supersededBy:before,...a}=claim;const {supersededBy:after,...b}=next;
  return isDeepStrictEqual(a,b)&&(!before||isDeepStrictEqual(before,after));
 }))});
 return checks;
}
export async function runClarifyPhase(records:LocalClarifyRecords,transport:typeof fetch,apiKey:string){
 const manifest=records.read<Manifest>("manifest.json");const session=records.read<Session>("session.json");
 if(records.firstEvent().manifestHash!==hash(manifest))throw new ClarifyStop("MANIFEST_CHANGED");
 if(!isDeepStrictEqual(manifest.fingerprint,codeFingerprint())||!isDeepStrictEqual(manifest.limits,clarifyLimits)||manifest.mode!==session.mode)throw new ClarifyStop("SESSION_INPUTS_CHANGED");
 if(session.phase==="complete"||session.phase==="stopped")throw new ClarifyStop("SESSION_CLOSED");
 for(const outcome of session.outcomes)if(outcome.outputHash!==undefined && outcome.outputHash!==hash({input:outcome.task,output:outcome.output}))throw new ClarifyStop("OUTCOME_CHANGED");
 const budget=new ClarifyBudget(manifest.config,records.event,records.lastBudget());
 const runner=createModelClarificationRunner({...manifest.config,apiKey,fetch:budget.fetch(transport),maxOutputTokens:clarifyLimits.outputPerRequest,onEvent:event=>{records.event(event);if(event.type==="runner_budget_exhausted"&&!budget.state.stopped)budget.stop(String(event.code));}});
 const reviews=records.read<Record<string,Review>>("reviews.json");
 async function execute(id:string,task:ClarificationTask){
  const snapshot=structuredClone(task),startedAt=new Date().toISOString(),start=Date.now();
  // Persist an attempt before any network operation. A crashed process retains .lock.
  records.event({type:"case_started",id,input:snapshot,prerequisite:id.startsWith("chain-")?"actual reviewed output":"reference snapshot"});
  let outcome:Outcome;
  try{
   budget.beginTask(id);
   const output=await evaluateClarification(task,runner);
   outcome={id,caseId:task.commandId,status:"generated",task:snapshot,output,outputHash:hash({input:snapshot,output}),checks:structuralGrade(task,snapshot,output),startedAt,elapsedMs:Date.now()-start};
  }catch(error){
   if(error instanceof ClarifyStop || budget.state.stopped){
    const code=error instanceof ClarifyStop?error.code:budget.state.stopped!;
    outcome={id,caseId:task.commandId,status:"execution_failed",task:snapshot,error:code,failure:classifyClarificationFailure(error),startedAt,elapsedMs:Date.now()-start};
    session.outcomes.push(outcome);records.write(`${id}.json`,outcome,true);throw new ClarifyStop(code);
   }
   const failure=classifyClarificationFailure(error);
   outcome={id,caseId:task.commandId,status:"execution_failed",task:snapshot,error:failure.code,failure,startedAt,elapsedMs:Date.now()-start};
   session.outcomes.push(outcome);records.write(`${id}.json`,outcome,true);
   // One invalid output ends the authorized phase; never spend on a repair or
   // continue other cases after a format/reference execution failure.
   throw new ClarifyStop(failure.code);
  }
  session.outcomes.push(outcome);records.write(`${id}.json`,outcome,true);recordReviewTemplate(records,outcome);records.event({type:"case_finished",id,status:outcome.status});records.write("session.json",session);
 }
 try{
  if(session.phase==="prepared"){
   for(const c of clarifyCases)await execute(c.id,realCaseTask(c.id));
   session.phase="awaiting_case1_review";
  }else if(session.phase==="awaiting_case1_review"){
   const first=session.outcomes.find(o=>o.id==="CLR-J01")!;
   if(definitiveFailure(first,reviews)){blockChain(records,session,["chain-6","chain-7"]);return writeSummary(records,session,"Chain blocked by case 1 failure; no reference output substituted.");}
   if(!judgedPass(first,reviews))return writeSummary(records,session,"Waiting for a passing, output-bound human review of case 1; no chain calls made.");
   const task=realCaseTask("CLR-J06");task.id="chain-6";task.inputId="chain-6-answer";task.base=structuredClone(first.output!.candidate);task.question=structuredClone(task.base.nextQuestion);task.baseUnderstandingId=`simulated-apply:${first.outputHash}`;task.baseRevision=first.task!.baseRevision+1;
   await execute("chain-6",task);session.phase="awaiting_chain6_review";
  }else{
   const sixth=session.outcomes.find(o=>o.id==="chain-6")!;
   if(definitiveFailure(sixth,reviews)){blockChain(records,session,["chain-7"]);return writeSummary(records,session,"Chain case 7 blocked by case 6 failure.");}
   if(!judgedPass(sixth,reviews))return writeSummary(records,session,"Waiting for a passing, output-bound human review of chain case 6; no case 7 call made.");
   const task=realCaseTask("CLR-J07");task.id="chain-7";task.inputId="chain-7-answer";task.base=structuredClone(sixth.output!.candidate);task.question=structuredClone(task.base.nextQuestion);task.baseUnderstandingId=`simulated-apply:${sixth.outputHash}`;task.baseRevision=sixth.task!.baseRevision+1;
   await execute("chain-7",task);session.phase="complete";
  }
 }catch(error){
  session.phase="stopped";
  // Never restart a batch or reclaim unknown costs after a stop.
  const stopped={type:"batch_stopped",code:error instanceof ClarifyStop?error.code:"LOCAL_FAILURE"};records.event(stopped);
  for(const id of [...clarifyCases.map(c=>c.id),"chain-6","chain-7"])if(!session.outcomes.some(o=>o.id===id))session.outcomes.push({id,caseId:id,status: /BUDGET$/.test(stopped.code) ? "not_run_budget" : "not_run_after_failure"});
 }
 records.write("session.json",session);return writeSummary(records,session);
}
function definitiveFailure(outcome:Outcome,reviews:Record<string,Review>){
 const r=reviews[outcome.id];return outcome.status!=="generated"||outcome.checks?.some(c=>!c.passed)||(r?.outputHash===outcome.outputHash&&(r.verdict==="fail"||r.criticalErrors?.length>0||Object.values(r.checks??{}).includes("fail")));
}
function blockChain(records:LocalClarifyRecords,session:Session,ids:string[]){
 for(const id of ids){const outcome:Outcome={id,caseId:id,status:"blocked"};session.outcomes.push(outcome);records.write(`${id}.json`,outcome,true);}
 session.phase="complete";records.write("session.json",session);records.event({type:"chain_blocked",ids});
}
export function writeSummary(records:LocalClarifyRecords,session=records.read<Session>("session.json"),note?:string,persist=true){
 const manifest=records.read<Manifest>("manifest.json");
 if(records.firstEvent().manifestHash!==hash(manifest))throw new ClarifyStop("MANIFEST_CHANGED");
 for(const outcome of session.outcomes)if(outcome.outputHash!==undefined&&(outcome.outputHash!==hash({input:outcome.task,output:outcome.output})||!isDeepStrictEqual(records.read(`${outcome.id}.json`),outcome)))throw new ClarifyStop("OUTCOME_CHANGED");
 const reviews=records.read<Record<string,Review>>("reviews.json");
 const criteriaMet=session.phase==="complete"&&session.outcomes.length===10&&session.outcomes.every(o=>judgedPass(o,reviews));
 const report={executionDiagnostics:records.executionDiagnostics(),httpDiagnostics:records.httpDiagnostics(),accounting:{provider:manifest.config.provider??"openai",inputAccounting:manifest.config.provider==="deepseek"?"context-window-reservation":"exact-provider-count",inputLimitKind:manifest.config.provider==="deepseek"?"post-response-stop-threshold":"pre-dispatch-bound",modelRequestLimit:deepSeekModelRequestLimit,observedVersion:manifest.config.provider==="deepseek"?manifest.config.observedVersion:undefined,versionPinned:manifest.config.provider!=="deepseek"},phase:session.phase,mode:session.mode,acceptedFirstRun:criteriaMet&&session.mode==="live-model",allCaseCriteriaMet:criteriaMet,scope:"Eight synthetic cases plus actual reviewed 1→6→7; no database or worker",note,budget:records.lastBudget(),outcomes:session.outcomes.map(o=>({id:o.id,status:o.status,error:o.error,failure:o.failure,automaticChecksPass:o.status==="generated"&&o.checks?.every(c=>c.passed),humanReview:reviews[o.id]?.verdict??"not_available",accepted:judgedPass(o,reviews)}))};
 if(persist)records.write("report.json",report);return report;
}
