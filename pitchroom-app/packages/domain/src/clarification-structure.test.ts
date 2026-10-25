import { expect,it } from "vitest";
import { buildReassessmentContext,newClarification,buildClarificationCandidate,recordClaimCorrection,understandingProposalV1Schema, type UnderstandingProposalV1 } from "./index";
const base:UnderstandingProposalV1={schemaVersion:1,themes:[{id:"one",title:"First",summary:"Open",claims:[{id:"prior",statement:"User's prior view",evidenceState:"user_asserted",evidence:[],userInputIds:["old"]}]}],gaps:[],nextQuestion:{question:"Original question",whyItMatters:"Why",relatedThemeIndexes:[0]}};
const source=(id:string,hash:string)=>({id,contentHash:hash,projectId:"p",name:id,mediaType:"text/markdown",chunks:[]});
const task=()=>newClarification({id:"task",inputId:"new",projectId:"p",commandId:"cmd",actorId:"user",versionId:"v1",revision:1,base,sources:[source("removed","v1"),source("changed","v1")],answer:"Corrected view"});
it("computes all source delta types and preserves the original question through repeated rebases",()=>{
 const old=task();const next=[source("changed","v2"),source("added","v1")];const context=buildReassessmentContext(old,next);
 expect(context.sourceChanges).toEqual({added:["added"],removed:["removed"],changed:["changed"]});
 const rebased={...task(),id:"new-task",sources:next,question:{...base.nextQuestion,question:"Different current question"},reassessment:context};
 expect(buildReassessmentContext(rebased,next)).toMatchObject({rebasedFromTaskId:"new-task",originalQuestion:base.nextQuestion,originalUnderstandingId:"v1",sourceChanges:{added:[],removed:[],changed:[]}});
});
it("manual editing a replacement preserves the whole correction chain",()=>{
 const proposal=structuredClone(base);recordClaimCorrection(proposal,0,0,"Second view","second");recordClaimCorrection(proposal,0,1,"Third view","third");
 expect(understandingProposalV1Schema.safeParse(proposal).success).toBe(true);expect(proposal.themes[0]!.claims.map(c=>c.statement)).toEqual(["User's prior view","Second view","Third view"]);
 expect(proposal.themes[0]!.claims[0]!.supersededBy!.replacementClaimId).toBe(proposal.themes[0]!.claims[1]!.id);expect(proposal.themes[0]!.claims[1]!.supersededBy!.inputId).toBe("third");
 expect(()=>recordClaimCorrection(proposal,0,0,"Rewrite history","bad")).toThrow(/history/);
});
it("correction operation order cannot change outcome and repeated corrections are rejected",()=>{
 const t=task();const ops=[{type:"supersede_user_assertion" as const,themeId:"one",claimId:"prior"},{type:"add_answer" as const,themeId:"one"},{type:"update_summary" as const,themeId:"one",text:"Corrected view"}];
 const forward=buildClarificationCandidate(t,{schemaVersion:2,reason:"Correction",operations:ops});const reverse=buildClarificationCandidate(t,{schemaVersion:2,reason:"Correction",operations:[...ops].reverse()});expect(forward).toEqual(reverse);
 expect(()=>buildClarificationCandidate({...t,base:forward,id:"next",inputId:"later"},{schemaVersion:2,reason:"Again",operations:ops})).toThrow(/active prior/);
 expect(()=>buildClarificationCandidate(t,{schemaVersion:2,reason:"Duplicate",operations:[...ops,ops[0]]})).toThrow(/Duplicate/);
});
