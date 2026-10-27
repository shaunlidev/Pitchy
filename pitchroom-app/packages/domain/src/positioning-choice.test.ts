import {sameStoryOrigin} from "./story";
import { expect, it } from "vitest";
import { assertPositioningHead, changePositioningChoice, positioningChoiceLabel, positioningChoices, positioningDecisionResult, positioningProposalV1Schema, readPositioning, resolvePositioningChoice, validateRetainedPositioningChoice, type PositioningRecord, type RetainedPositioningChoice } from "./positioning";
function record(): PositioningRecord { return {id:"p1",proposal:positioningProposalV1Schema.parse({schemaVersion:1,understandingVersionId:"u1",originalFraming:{title:"Original framing",coreMessage:"An accepted interpretation.",origin:"accepted_understanding"},directions:["a","b"].map(id=>({id,title:id,coreMessage:`AI ${id}`,from:"before",to:"after",tradeoff:"narrow",excludes:[],evidence:[{sourceId:"s",chunkId:"c",quote:"Exact words."}],userInputIds:[]}))})}; }
it("keeps accepted interpretation, source wording and manual exact wording distinct without inventing a missing quote",()=>{
 const r=record();expect(positioningChoices(r.proposal).map(c=>c.kind)).toEqual(["accepted_understanding","ai_direction","ai_direction"]);
 const raw=structuredClone(r.proposal);delete raw.originalFraming.origin;expect(positioningChoiceLabel(resolvePositioningChoice(raw,"original"))).toBe("Saved framing · origin unrecorded");
 const manual:RetainedPositioningChoice={kind:"manual_exact",understandingId:"u1",id:"m",text:"  My exact words.\n",userInputId:"input"};r.proposal.retainedChoices=[manual];
 expect(resolvePositioningChoice(r.proposal,"m").text).toBe(manual.text);expect(positioningChoiceLabel(manual)).toContain("unverified");expect(()=>resolvePositioningChoice(r.proposal,"missing")).toThrow(/does not exist/);
});
it("requires explicit Apply, rejects ABA stale heads, and replays the exact earlier decision",()=>{
 let r=record();const before=structuredClone(r.proposal);expect(readPositioning(r).applied).toBeNull();
 r={...r,...changePositioningChoice(r,{kind:"apply",choiceId:"a"},"cmd1","d1")};const head=readPositioning(r).head;
 r={...r,...changePositioningChoice(r,{kind:"apply",choiceId:"b"},"cmd2","d2")};r={...r,...changePositioningChoice(r,{kind:"apply",choiceId:"a"},"cmd3","d3")};
 expect(()=>assertPositioningHead(r,head)).toThrow(/changed/);expect(readPositioning(positioningDecisionResult(r,"d1")).applied?.choice.text).toBe("AI a");expect(readPositioning(r).head.decisionId).toBe("d3");expect(before.decisionJournal).toBeUndefined();
 r={...r,...changePositioningChoice(r,{kind:"undo"},"undo","d4")};expect(readPositioning(r).applied?.choice.text).toBe("AI b");expect(()=>changePositioningChoice(r,{kind:"undo"},"undo2","d5")).toThrow(/no positioning/);
});
it("saving or editing a candidate cannot change the frozen applied choice",()=>{
 const base=record();const applied={...base,...changePositioningChoice(base,{kind:"apply",choiceId:"a"},"apply","decision")};
 const next=structuredClone(applied);next.id="p2";next.proposal.directions[0]!.coreMessage="Unsaved candidate wording";next.proposal.retainedChoices=[{kind:"manual_exact",understandingId:"u1",id:"m",text:"New candidate",userInputId:"i"}];
 expect(readPositioning(next).applied).toEqual(readPositioning(applied).applied);expect(resolvePositioningChoice(next.proposal,"a").text).toBe("Unsaved candidate wording");expect(readPositioning(next).applied?.choice.text).toBe("AI a");
});
it("binds a literal source range to the active project, source hash and chunk",()=>{
 const quote:RetainedPositioningChoice={kind:"source_quote",understandingId:"u1",id:"q",projectId:"project",sourceId:"s",sourceName:"brief.md",sourceHash:"hash",passage:"  Exact words. other",chunkId:"c",start:2,end:14,text:"Exact words.",userInputId:"i"};
 const sources=[{id:"s",name:"brief.md",contentHash:"hash",chunks:[{id:"c",sourceId:"s",text:"  Exact words. other",startOffset:0,endOffset:20}]}];
 expect(()=>validateRetainedPositioningChoice(quote,"project",sources)).not.toThrow();expect(()=>validateRetainedPositioningChoice(quote,"foreign",sources)).toThrow(/unavailable/);expect(()=>validateRetainedPositioningChoice(quote,"project",[])).toThrow(/unavailable/);
 expect(()=>validateRetainedPositioningChoice({...quote,text:"Invented wording"},"project",sources)).toThrow(/unavailable/);expect(()=>validateRetainedPositioningChoice({...quote,sourceHash:"old"},"project",sources)).toThrow(/changed/);
});

it("uses exact decisions for Story compatibility and limits legacy fallback to legacy origins",()=>{
 const legacy={understandingVersionId:"u",positioningVersionId:"p",directionId:"a",sourceFingerprint:"sources"};
 expect(sameStoryOrigin(legacy,{...legacy})).toBe(true);
 expect(sameStoryOrigin(legacy,{...legacy,positioningDecisionId:"legacy:p:a"})).toBe(true);
 expect(sameStoryOrigin(legacy,{...legacy,positioningDecisionId:"new-decision"})).toBe(false);
 expect(sameStoryOrigin({...legacy,positioningDecisionId:"one"},{...legacy,positioningDecisionId:"two"})).toBe(false);
 expect(sameStoryOrigin({...legacy,positioningDecisionId:"one"},{...legacy,positioningVersionId:"new-candidate-row",positioningDecisionId:"one"})).toBe(true);
});
