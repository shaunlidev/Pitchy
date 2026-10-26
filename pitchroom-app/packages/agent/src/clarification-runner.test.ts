import { describe,it,expect } from "vitest";
import { startClarificationAttempt,ownsClarificationAttempt,ingestMaterial,newClarification,buildClarificationCandidate } from "@pitchroom/domain";
import { buildDeterministicUnderstanding } from "./deterministic-runner";
import { evaluateClarification,DeterministicClarificationRunner } from "./clarification-runner";
const source=ingestMaterial("project",{name:"brief.md",mediaType:"text/markdown",text:"Northwind sells consumer menu planning."});
const task=()=>newClarification({id:"task",inputId:"input",projectId:"project",commandId:"command",actorId:"user",versionId:"v1",revision:1,base:buildDeterministicUnderstanding({projectId:"project",chunks:source.chunks}).proposal,sources:[{...source,id:source.sourceId,projectId:"project"}],answer:"Procurement must approve a pilot."});
describe("bounded feedback proposals",()=>{
 it("keeps direct user words and interpretation distinguishable",async()=>{const t=task();const output=await evaluateClarification(t,new DeterministicClarificationRunner());expect(output.candidate.themes[0]!.summaryInterpretation!.inputIds).toEqual([t.inputId]);expect(output.candidate.themes[0]!.claims.at(-1)!.statement).toBe(t.answer);expect(output.candidate.themes[0]!.claims.at(-1)!.evidence).toEqual([]);});
 it("rejects nonexistent or repeated modification targets",()=>{expect(()=>buildClarificationCandidate(task(),{reason:"test",operations:[{type:"update_summary",themeId:"missing",text:"changed"}]})).toThrow(/Unknown/);const op={type:"add_answer",themeId:task().base.themes[0]!.id};expect(()=>buildClarificationCandidate(task(),{reason:"test",operations:[op,op]})).toThrow(/Duplicate/);});
 it("does not permit arbitrary replacement of claims or fabricated input ids",()=>{expect(()=>buildClarificationCandidate(task(),{reason:"test",operations:[{type:"replace_claim",statement:"invented",userInputIds:["fake"]}]})).toThrow();});
});

describe("durable attempt ownership",()=>{
 it("fences an old worker after lease recovery",()=>{const t=task();startClarificationAttempt(t,"fake",1000);const old=structuredClone(t);startClarificationAttempt(t,"fake",92000);expect(t.attempts).toHaveLength(2);expect(ownsClarificationAttempt(t,old)).toBe(false);expect(ownsClarificationAttempt(t,t)).toBe(true);});
 it("bounds automatic recovery and does not erase the original answer",()=>{const t=task();startClarificationAttempt(t,"fake",1000);startClarificationAttempt(t,"fake",92000);startClarificationAttempt(t,"fake",183000);expect(startClarificationAttempt(t,"fake",274000)).toBe(false);expect(t.status).toBe("failed");expect(t.attempts).toHaveLength(3);expect(t.answer).toBe("Procurement must approve a pilot.");});
 it("does not let a dismissed task be completed by an old worker",()=>{const t=task();startClarificationAttempt(t,"fake");const old=structuredClone(t);t.status="dismissed";expect(ownsClarificationAttempt(t,old)).toBe(false);});
});
