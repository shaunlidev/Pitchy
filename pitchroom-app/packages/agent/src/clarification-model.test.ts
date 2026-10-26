import { coreMessageWireFixture, liveDeckWireFixture } from "./presentation.testkit";
import { legacyResultRunner } from "./clarification-model.testkit";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { activeUnderstanding, buildClarificationCandidate, buildReassessmentContext, clarificationResultSchema, clarificationTaskSchema, newClarification, type ClarificationResult, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { ModelClarificationRunner, evaluateClarification } from "./clarification-runner";
import { groundedV4TestResult, mockUsage, scriptedClarificationModel } from "./clarification-model.testkit";

const sources=[{id:"s1",projectId:"p",name:"pilot.md",mediaType:"text/markdown",contentHash:"v1",chunks:[{id:"c1",sourceId:"s1",text:"One department; four weeks suggested.",startOffset:0,endOffset:37}]}];
const base:UnderstandingProposalV1={schemaVersion:1,themes:[
 {id:"audience",title:"Audience",summary:"Decision unknown.",claims:[{id:"source-claim",statement:sources[0]!.chunks[0]!.text,evidenceState:"supported",evidence:[{sourceId:"s1",chunkId:"c1",quote:sources[0]!.chunks[0]!.text}],userInputIds:[]}]},
 {id:"pilot",title:"Pilot",summary:"User reported a 20% agreed target.",claims:[{id:"prior-answer",statement:"Procurement agreed to 20%.",evidenceState:"user_asserted",evidence:[],userInputIds:["previous-input"]}]},
],gaps:[],nextQuestion:{question:"Who decides?",whyItMatters:"Scope",relatedThemeIndexes:[0]}};
function task(){return newClarification({id:"task",inputId:"answer",projectId:"p",commandId:"cmd",actorId:"user",versionId:"v1",revision:1,base,sources,answer:"20% was my suggestion; procurement has not agreed."});}
const correction:ClarificationResult={schemaVersion:2,reason:"User corrects the attribution; sources remain unchanged.",operations:[
 {type:"supersede_user_assertion",themeId:"pilot",claimId:"prior-answer"},
 {type:"add_answer",themeId:"pilot"},
 {type:"update_summary",themeId:"pilot",text:"20% is a user suggestion, not an agreed target."},
 {type:"next_question",question:"What target would procurement agree to?",whyItMatters:"The criterion is unconfirmed.",relatedThemeIds:["pilot"]},
]};
afterEach(()=>vi.unstubAllGlobals());
describe("formal Clarify runner with an offline model provider",()=>{
 it("executes a real source tool, validates correction and associates the next question",async()=>{
  vi.stubGlobal("fetch",vi.fn(()=>{throw new Error("Network forbidden in offline test");}));
  const t=task(),before=structuredClone(t);const model=scriptedClarificationModel(groundedV4TestResult(correction,base),"c1");
  const output=await evaluateClarification(t,legacyResultRunner(model));
  expect(model.doGenerateCalls).toHaveLength(2);
  expect(JSON.stringify(model.doGenerateCalls[1]!.prompt)).toContain("One department; four weeks suggested.");
  expect(output.candidate.nextQuestion.relatedThemeIndexes).toEqual([1]);
  expect(output.candidate.themes[1]!.claims[0]!.supersededBy).toEqual({inputId:t.inputId,taskId:t.id,replacementClaimId:"task:answer:pilot"});
  expect(output.candidate.themes[1]!.claims[1]!.statement).toBe(t.answer);
  expect(output.candidate.themes[0]).toEqual(t.base.themes[0]);expect(t).toEqual(before);
 });
 it("provides active assertions and separately labelled historical corrections to the next run",async()=>{
  const t=task();t.base=buildClarificationCandidate(t,correction);
  const model=scriptedClarificationModel(groundedV4TestResult({schemaVersion:2,reason:"No further change justified.",operations:[]},base));
  await evaluateClarification(t,legacyResultRunner(model));
  const message=model.doGenerateCalls[0]!.prompt.find(m=>m.role==="user")!;
  const context=JSON.parse((message.content as Array<{text:string}>)[0]!.text);
  expect(context.base.themes[1].claims.map((c:{statement:string})=>c.statement)).toEqual([t.answer]);
  expect(context.supersededHistory[0].claim.statement).toBe("Procurement agreed to 20%.");
  expect(activeUnderstanding(t.base).themes[1]!.claims).toHaveLength(1);
 });
 it("passes original question and material delta to formal reassessment",async()=>{
  const old=task();const added={...sources[0]!,id:"client",name:"approval.md",chunks:[],contentHash:"two-week-window"};
  const t=task();t.sources=[...sources,added];t.reassessment=buildReassessmentContext(old,t.sources);t.question={...t.question,question:"Which baseline?"};
  const model=scriptedClarificationModel(groundedV4TestResult({schemaVersion:2,reason:"No automatic choice.",operations:[]},base));
  await evaluateClarification(t,legacyResultRunner(model));
  const prompt=JSON.stringify(model.doGenerateCalls[0]!.prompt);expect(prompt).toContain('originalQuestion');expect(prompt).toContain('Who decides?');expect(prompt).toContain('Which baseline?');expect(prompt).toContain('approval.md');expect(t.reassessment.sourceChanges.added).toEqual(["client"]);
 });
 it.each([
  ["unknown theme",{schemaVersion:2,reason:"test",operations:[{type:"next_question",question:"What?",whyItMatters:"Why",relatedThemeIds:["missing"]}]}],
  ["duplicate theme",{schemaVersion:2,reason:"test",operations:[{type:"next_question",question:"What?",whyItMatters:"Why",relatedThemeIds:["pilot","pilot"]}]}],
  ["missing association",{schemaVersion:2,reason:"test",operations:[{type:"next_question",question:"What?",whyItMatters:"Why"}]}],
  ["source correction",{...correction,operations:[...correction.operations,{type:"supersede_user_assertion",themeId:"audience",claimId:"source-claim"}]}],
  ["missing correction target",{...correction,operations:[...correction.operations,{type:"supersede_user_assertion",themeId:"pilot",claimId:"absent"}]}],
  ["missing replacement",{schemaVersion:2,reason:"test",operations:[{type:"supersede_user_assertion",themeId:"pilot",claimId:"prior-answer"}]}],
 ])("rejects %s without mutating the saved task",async(_label,invalid)=>{
  const t=task(),snapshot=structuredClone(t);
  await expect(evaluateClarification(t,legacyResultRunner(scriptedClarificationModel(groundedV4TestResult(invalid as ClarificationResult,base))))).rejects.toThrow();expect(t).toEqual(snapshot);
 });
 it("keeps saved v1 results readable while requiring v4 from the formal model",async()=>{
  const legacy={reason:"Legacy",operations:[{type:"next_question",question:"What?",whyItMatters:"Why"}]};
  expect(clarificationResultSchema.parse(legacy)).toEqual(legacy);expect(clarificationTaskSchema.parse(task()).reassessment).toBeUndefined();
  expect(buildClarificationCandidate(task(),legacy).nextQuestion.relatedThemeIndexes).toEqual([0]);
  await expect(evaluateClarification(task(),legacyResultRunner(scriptedClarificationModel(legacy)))).rejects.toThrow();
  expect(()=>buildClarificationCandidate({...task(),result:correction},legacy)).toThrow(/downgraded/);
 });
 it("bounds a stalled provider without losing saved input",async()=>{
  const t=task(),answer=t.answer;
  const model=new MockLanguageModelV4({doGenerate:async options=>new Promise((_resolve,reject)=>{const signal=options.abortSignal!; if(signal.aborted)reject(signal.reason);else signal.addEventListener("abort",()=>reject(signal.reason),{once:true});})});
  await expect(evaluateClarification(t,legacyResultRunner(model,30))).rejects.toThrow("TIME_BUDGET");expect(t.answer).toBe(answer);
 });
 it("rejects malformed model JSON",async()=>{
  const model=new MockLanguageModelV4({doGenerate:{content:[{type:"text",text:"{invalid"}],finishReason:{unified:"stop",raw:"stop"},usage:mockUsage,warnings:[]}});
  await expect(evaluateClarification(task(),legacyResultRunner(model))).rejects.toThrow();
 });
});

it("keeps corrected assertions out of downstream positioning and deck request contexts",async()=>{
 const {ResponsesPositioningRunner,buildDeterministicPositioning}=await import("./positioning-runner");
 const {ResponsesDeckRunner,buildDeterministicDeck}=await import("./deck-runner");
 const understanding=buildClarificationCandidate(task(),correction);
 const chunks=sources.flatMap(s=>s.chunks);
 const positioningInput={understandingVersionId:"v2",understanding,chunks};
 const positioning=buildDeterministicPositioning(positioningInput);
 const requests:string[]=[];
 const offlineFetch=(output:unknown)=>vi.fn(async (_url:unknown,init?:RequestInit)=>{
  requests.push(String(init!.body));return new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(output)}]}]}),{status:200});
 });
 await new ResponsesPositioningRunner({apiKey:"offline",model:"offline",baseURL:"http://offline.invalid",fetch:offlineFetch(coreMessageWireFixture(positioning))}).run(positioningInput);
 const deckInput={...positioningInput,positioningVersionId:"p1",positioning,appliedDirectionId:positioning.directions[0]!.id};
 const deck=buildDeterministicDeck(deckInput);
 await new ResponsesDeckRunner({apiKey:"offline",model:"offline",baseURL:"http://offline.invalid",fetch:offlineFetch(liveDeckWireFixture(deck,positioning.directions[0]!.coreMessage))}).run(deckInput);
 for(const body of requests){const request=JSON.parse(body);const context=JSON.parse(request.input[1].content);expect(context.understanding.themes[1].claims.map((c:{statement:string})=>c.statement)).toEqual([task().answer]);}
 expect(understanding.themes[1]!.claims).toHaveLength(2);
});

it.each(["TOOL_CALL_BUDGET","TOOL_CONTEXT_BUDGET","STEP_BUDGET"])("stops the formal agent loop when %s is exhausted",async(code)=>{
 const t=task();if(code==="TOOL_CONTEXT_BUDGET")t.sources[0]!.chunks[0]!.text="x".repeat(60001);
 let count=0;
 const model=new MockLanguageModelV4({doGenerate:async()=>({content:Array.from({length:code==="TOOL_CALL_BUDGET"?13:1},()=>({type:"tool-call" as const,toolCallId:`read-${++count}`,toolName:"read_chunk",input:JSON.stringify({chunkId:"c1"})})),finishReason:{unified:"tool-calls",raw:"tool_calls"},usage:mockUsage,warnings:[]})});
 const events:Record<string,unknown>[]=[];
 await expect(evaluateClarification(t,legacyResultRunner(model,60000,{onEvent:e=>events.push(e)}))).rejects.toThrow(code);
 expect(events).toContainEqual({type:"runner_budget_exhausted",code});expect(model.doGenerateCalls).toHaveLength(code==="STEP_BUDGET"?6:1);
});
