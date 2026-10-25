import { isDeepStrictEqual } from "node:util";
import { DeterministicClarificationRunner, evaluateClarification } from "@pitchroom/agent";
import { assertClarificationFresh, type ClarificationResult, type ClarificationTask, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { clarifyCases, taskForCase, type ClarifyCase } from "./clarification-cases";

export function gradeClarification(c:ClarifyCase,task:ClarificationTask,result:ClarificationResult,candidate:UnderstandingProposalV1){
 const checks:Array<{name:string;passed:boolean}>=[];
 const add=(name:string,passed:boolean)=>checks.push({name,passed});
 add("base_snapshot_not_mutated",isDeepStrictEqual(task.base,taskForCase(c).base));
 add("original_claims_preserved",task.base.themes.every((theme,i)=>theme.claims.every((claim,j)=>isDeepStrictEqual(claim,candidate.themes[i]?.claims[j]))));
 add("gaps_preserved",isDeepStrictEqual(candidate.gaps,task.base.gaps));
 add("new_claims_are_exact_attributed_answer",candidate.themes.every((theme,i)=>theme.claims.slice(task.base.themes[i]!.claims.length).every(claim=>claim.statement===task.answer && claim.evidenceState==="user_asserted" && claim.evidence.length===0 && isDeepStrictEqual(claim.userInputIds,[task.inputId]))));
 if(c.noChange){
  add("no_understanding_change",isDeepStrictEqual(candidate.themes,task.base.themes));
  if(c.id==="CLR-J03")add("unknown_does_not_force_new_question",!result.operations.some(op=>op.type==="next_question"));
 }else{
  const targets=result.operations.filter(op=>op.type!=="next_question").map(op=>op.themeId);
  add("only_relevant_theme_targeted",targets.length>0 && targets.every(id=>id===c.target));
  add("unrelated_themes_unchanged",task.base.themes.every((theme,i)=>theme.id===c.target || isDeepStrictEqual(theme,candidate.themes[i])));
  const summary=candidate.themes.find(t=>t.id===c.target)!.summary;
  add("relevant_summary_changed",summary!==task.base.themes.find(t=>t.id===c.target)!.summary);
  if(result.operations.some(op=>op.type==="next_question"))add("next_question_related_to_target",candidate.nextQuestion.relatedThemeIndexes.includes(task.base.themes.findIndex(t=>t.id===c.target)));
  add("required_meaning_markers",c.required.every(pattern=>pattern.test(summary)));
 }
 return checks;
}
export async function runClarificationOffline(){
 const runner=new DeterministicClarificationRunner();
 const reports=[];
 for(const c of clarifyCases){
  const task=taskForCase(c);const snapshot=structuredClone(task);
  const output=await evaluateClarification(task,runner);
  if(c.id==="CLR-J08"){
   const updatedSources=[...structuredClone(task.sources),{id:"client-window",projectId:task.projectId,name:"client-window.md",mediaType:"text/markdown",contentHash:"synthetic-two-weeks",chunks:[{id:"window-chunk",sourceId:"client-window",text:"客户只批准两周窗口。",startOffset:0,endOffset:11}]}];
   let rejected=false;try{assertClarificationFresh(task,{phase:"review_required",revision:task.baseRevision,understandingId:task.baseUnderstandingId,sources:updatedSources});}catch{rejected=true;}
   const rebased=structuredClone(task);rebased.sources=updatedSources;rebased.id+="-reassessed";
   const reassessed=await evaluateClarification(rebased,runner);
   const checks=[{name:"changed_material_rejects_old_proposal",passed:rejected},{name:"answer_and_old_proposal_preserved",passed:isDeepStrictEqual(task,snapshot)&&Boolean(output.result)},...gradeClarification(c,rebased,reassessed.result,reassessed.candidate)];
   reports.push({id:c.id,title:c.title,contract:{mustChange:c.mustChange,mustPreserve:c.mustPreserve,mustNot:c.mustNot},observed:{original:output,reassessed},scope:"domain stale guard + explicit new-snapshot reassessment simulation; no database/API rebase",checks,judgment:checks.every(x=>x.passed)?"OFFLINE_CHECKS_PASS_QUALITY_PENDING":"CURRENT_IMPLEMENTATION_GAP",humanReview:c.humanReview});
  }else{
   const checks=gradeClarification(c,task,output.result,output.candidate);
   reports.push({id:c.id,title:c.title,contract:{mustChange:c.mustChange,mustPreserve:c.mustPreserve,mustNot:c.mustNot},observed:output,scope:c.prerequisite?`isolated accepted reference: ${c.prerequisite}; not actual prior runner output`:"initial synthetic project",checks,judgment:checks.every(x=>x.passed)?"OFFLINE_CHECKS_PASS_QUALITY_PENDING":"CURRENT_IMPLEMENTATION_GAP",humanReview:c.humanReview});
  }
 }
 // Also execute 1 → 6 → 7 on actual runner candidates, without replacing failures
 // with accepted reference outputs. This is an in-memory simulation of explicit Apply.
 let current=taskForCase(clarifyCases[0]!).base;const chain=[];
 for(const id of ["CLR-J01","CLR-J06","CLR-J07"]){const c=clarifyCases.find(c=>c.id===id)!;const task=taskForCase(c);task.base=structuredClone(current);task.question=structuredClone(current.nextQuestion);const output=await evaluateClarification(task,runner);const target=output.candidate.themes.find(t=>t.id===c.target)!;chain.push({id,changedThemes:output.candidate.themes.filter((t,i)=>!isDeepStrictEqual(t,current.themes[i])).map(t=>t.id),requiredMeaningPresent:c.required.every(p=>p.test(target.summary))});current=output.candidate;}
 return {mode:"offline-deterministic-only",evidenceBoundary:"No database, browser, real model, or human quality acceptance. Pattern checks are necessary proxies, not semantic proof.",cases:reports,actualOutputChain:chain,summary:{offlineChecksPass:reports.filter(r=>r.judgment==="OFFLINE_CHECKS_PASS_QUALITY_PENDING").map(r=>r.id),currentGaps:reports.filter(r=>r.judgment==="CURRENT_IMPLEMENTATION_GAP").map(r=>r.id),staleGuardPassed:reports.filter(r=>r.checks.some(c=>c.name==="changed_material_rejects_old_proposal"&&c.passed)).map(r=>r.id),realModelAndHumanReviewRequired:clarifyCases.map(c=>c.id)}};
}
