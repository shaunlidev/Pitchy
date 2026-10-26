import { coreMessageWireFixture, liveDeckWireFixture } from "./presentation.testkit";
import { legacyResultRunner } from "./clarification-model.testkit";
import { expect, it, vi } from "vitest";
import { MockLanguageModelV4 } from "ai/test";
import { buildClarificationCandidate, clarificationResultSchema, clarificationTaskSchema, clarificationBasisV4Label, newClarification, type ClarificationResult, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { evaluateClarification, ModelClarificationRunner, clarificationModelContext } from "./clarification-runner";
import { ClarificationFailure, classifyClarificationFailure } from "./clarification-failure";
import { scriptedClarificationModel, mockUsage } from "./clarification-model.testkit";

const text="A three-day workshop is suggested. Legal sign-off is required before public launch.";
const source={id:"guide",projectId:"p",name:"guide.md",mediaType:"text/markdown",contentHash:"v1",chunks:[{id:"c",sourceId:"guide",text,startOffset:0,endOffset:text.length}]};
const base:UnderstandingProposalV1={schemaVersion:1,themes:[{id:"plan",title:"Workshop plan",summary:"Current goal unknown.",claims:[{id:"old-plan",statement:text,evidenceState:"supported",evidence:[{sourceId:"guide",chunkId:"c",quote:text}],userInputIds:[]}]},{id:"evaluation",title:"Evaluation",summary:"Success metric unknown.",claims:[{id:"unknown",statement:"Metric unknown",evidenceState:"unknown",evidence:[],userInputIds:[]}]},{id:"approval",title:"Approval",summary:"Reviewer unknown.",claims:[{id:"reviewer",statement:"Reviewer unknown",evidenceState:"unknown",evidence:[],userInputIds:[]}]}],gaps:[],nextQuestion:{question:"What is the current goal?",whyItMatters:"Focus",relatedThemeIndexes:[0]}};
function task(){return newClarification({id:"task",inputId:"answer",projectId:"p",commandId:"cmd",actorId:"user",versionId:"v1",revision:1,base,sources:[source],answer:"The sponsor said sign-off requires a benchmark report. I suggest an internal workshop first."});}
type V4=Extract<ClarificationResult,{schemaVersion:4}>;
function proposal():V4{return {schemaVersion:4,reason:"Current user goal differs from the guide; the metric remains unknown.",bases:[
 {id:"duration",origin:"material",nature:"suggestion",requirement:null,statement:"Guide suggests a three-day workshop.",scope:"Suggested workshop plan; not an approval condition",evidence:[{sourceId:"guide",chunkId:"c",quote:"A three-day workshop is suggested."}]},
 {id:"launch",origin:"material",nature:"requirement",requirement:{issuer:"Guide author",action:"Obtain legal sign-off",condition:"Before public launch",supportingQuote:"Legal sign-off is required before public launch."},statement:"Guide requires legal sign-off before launch.",scope:"Public launch only",evidence:[{sourceId:"guide",chunkId:"c",quote:"Legal sign-off is required before public launch."}]},
 {id:"report",origin:"user",nature:"requirement",requirement:{issuer:"Sponsor, as reported by user",action:"Provide a benchmark report",condition:"For sponsor sign-off, as reported",supportingQuote:"The sponsor said sign-off requires a benchmark report."},statement:"User reports a sponsor requirement.",scope:"User report; not independently verified",inputIds:["answer"]},
 {id:"help",origin:"agent",nature:"suggestion",requirement:null,statement:"Clarifying a metric could help evaluate the workshop.",scope:"Agent suggestion; no approval condition inferred"},
],reasonBasisRefs:["duration","launch","report","help"],operations:[
 {type:"add_answer",themeId:"plan"},
 {type:"update_summary",themeId:"plan",text:"User suggests an internal workshop. Duration is a material suggestion; public-launch sign-off is separate. Sponsor's benchmark request is a user report.",basisRefs:["duration","launch","report"],applicability:[{claimId:"old-plan",status:"differs",currentInterpretation:"The current goal is an internal workshop, not public launch.",explanation:"Original guide and quotes remain preserved.",basisRefs:["duration","launch","report"]}]},
 {type:"next_question",question:"Which benchmark metric defines success?",whyItMatters:"A metric could help evaluate results; approval conditions remain attributed to the user report.",relatedThemeIds:["evaluation"],groundingV4:{objective:"Clarify one evaluation criterion",primaryThemeId:"evaluation",associations:[{themeId:"evaluation",unresolvedIssue:"Success metric unknown",rationale:"The answer directly identifies a success metric.",questionSpan:"Which benchmark metric",expectedAnswer:"A concrete evaluation metric"}],basisRefs:["help","report"]}},
]};}
function rawModel(text:string,finish:"stop"|"length"="stop") {return new MockLanguageModelV4({doGenerate:{content:[{type:"text",text}],finishReason:{unified:finish,raw:finish},usage:mockUsage,warnings:[]}});}

it("uses a single basis table for source suggestions, scoped requirements and unverified reported requirements",async()=>{
 const t=task(),before=structuredClone(t),model=scriptedClarificationModel(proposal(),"c"),network=vi.spyOn(globalThis,"fetch").mockRejectedValue(Error("Offline only"));
 try{
  const output=await evaluateClarification(t,legacyResultRunner(model));expect(network).not.toHaveBeenCalled();expect(model.doGenerateCalls).toHaveLength(2);expect(t).toEqual(before);
  const metadata=output.candidate.themes[0]!.summaryInterpretation!.groundingV4!;
  expect(metadata.bases.map(b=>b.id)).toEqual(["duration","launch","report"]);expect(metadata.basisRefs).toEqual(["duration","launch","report"]);
  expect(output.candidate.themes[0]!.claims[0]).toEqual(base.themes[0]!.claims[0]);expect(output.candidate.themes[1]).toEqual(base.themes[1]);expect(output.candidate.nextQuestion.relatedThemeIndexes).toEqual([1]);
  expect(clarificationBasisV4Label(proposal().bases[0]!)).toBe("Material · suggestion");expect(clarificationBasisV4Label(proposal().bases[2]!)).toBe("User report · unverified · requirement");
  expect(clarificationTaskSchema.parse({...t,result:output.result,candidate:output.candidate}).result).toEqual(proposal());
  const nextContext=clarificationModelContext({...t,base:output.candidate});expect(JSON.stringify(nextContext)).toContain("supportingQuote");expect(JSON.stringify(nextContext)).toContain("questionSpan");
 }finally{network.mockRestore();}
});
const mutations:Array<[string,(p:any)=>void,string,string]>=[
 ["duplicate ID",p=>{p.bases[1].id=p.bases[0].id;},"reference","DUPLICATE_BASIS_ID"],
 ["duplicate content under another ID",p=>{p.bases.push({...p.bases[0],id:"copy"});},"reference","DUPLICATE_BASIS_CONTENT"],
 ["unknown basis reference",p=>{p.reasonBasisRefs.push("absent");},"reference","INVALID_BASIS_REFERENCE"],
 ["duplicate use reference",p=>{p.operations[1].basisRefs.push("duration");},"reference","INVALID_BASIS_REFERENCE"],
 ["unused table entry",p=>{p.bases.push({id:"unused",origin:"agent",nature:"interpretation",requirement:null,statement:"An unused remark",scope:"Synthetic"});},"reference","UNUSED_BASIS_ENTRY"],
 ["suggestion carrying requirement metadata",p=>{p.bases[0].requirement=p.bases[1].requirement;},"judgment","NON_REQUIREMENT_HAS_CONSTRAINT"],
 ["requirement without a constraint",p=>{p.bases[1].requirement=null;},"judgment","UNSUPPORTED_REQUIREMENT"],
 ["Agent inventing a requirement",p=>{p.bases[3].nature="requirement";p.bases[3].requirement=p.bases[1].requirement;},"judgment","UNSUPPORTED_REQUIREMENT"],
 ["uncited requirement words",p=>{p.bases[1].requirement.supportingQuote="Launch requires a ten-day workshop.";},"reference","REQUIREMENT_QUOTE_NOT_CITED"],
 ["unreported user requirement words",p=>{p.bases[2].requirement.supportingQuote="The sponsor guaranteed approval.";},"reference","REQUIREMENT_QUOTE_NOT_REPORTED"],
 ["unknown user input",p=>{p.bases[2].inputIds=["missing"];},"reference","INVALID_USER_REFERENCE"],
 ["cross-source quotation",p=>{p.bases[0].evidence[0].sourceId="other";},"reference","INVALID_SOURCE_QUOTE"],
 ["missing applicability coverage",p=>{p.operations[1].applicability=[];},"reference","INVALID_APPLICABILITY_COVERAGE"],
 ["Agent-only applicability confirmation",p=>{p.operations[1].applicability[0].status="confirmed";p.operations[1].applicability[0].basisRefs=["help"];},"judgment","APPLICABILITY_WITHOUT_ATTRIBUTION"],
 ["extra related theme without association",p=>{p.operations[2].relatedThemeIds.push("approval");},"reference","INVALID_QUESTION_ASSOCIATION"],
 ["duplicate association",p=>{p.operations[2].groundingV4.associations.push(p.operations[2].groundingV4.associations[0]);},"reference","INVALID_QUESTION_ASSOCIATION"],
 ["question span absent from actual question",p=>{p.operations[2].groundingV4.associations[0].questionSpan="Who will approve launch?";},"reference","QUESTION_SPAN_NOT_PRESENT"],
];
it.each(mutations)("rejects %s with a specific failure stage and retains the saved snapshot",async(_name,mutate,stage,code)=>{
 const t=task(),before=structuredClone(t),p=proposal();mutate(p);const model=scriptedClarificationModel(p);
 await expect(evaluateClarification(t,legacyResultRunner(model))).rejects.toMatchObject({diagnostic:{stage,code}});expect(t).toEqual(before);expect(model.doGenerateCalls).toHaveLength(1);
});
it("allows a genuine joint question when each theme has words requesting its missing information",()=>{
 const p=proposal(),q=p.operations[2]!;if(q.type!=="next_question")throw Error();q.question="Which benchmark metric defines success, and who reviews it?";q.relatedThemeIds.push("approval");q.groundingV4.associations.push({themeId:"approval",unresolvedIssue:"Reviewer unknown",rationale:"The question directly asks for the reviewer.",questionSpan:"who reviews it",expectedAnswer:"An identified reviewer, or explicitly unknown"});
 expect(buildClarificationCandidate(task(),p).nextQuestion.relatedThemeIndexes).toEqual([1,2]);
});
it.each(["record","suggestion","uncertain"] as const)("permits material nature %s without inventing a requirement",nature=>{
 const p=proposal();p.bases[0]!.nature=nature;p.bases[0]!.requirement=null;
 expect(buildClarificationCandidate(task(),p).themes[0]!.summaryInterpretation!.groundingV4!.bases[0]!.nature).toBe(nature);
});
it("retains original basis and flags user wording; Apply cannot relabel sources, question targets or version",()=>{
 const t=task();t.result=proposal();const original=structuredClone(t.result),edited=proposal();const s=edited.operations[1]!;if(s.type!=="update_summary")throw Error();s.text="My revised interpretation.";
 const candidate=buildClarificationCandidate(t,edited);expect(candidate.themes[0]!.summaryInterpretation!.groundingV4!.reviewStatus).toBe("user_edited_unreviewed");expect(t.result).toEqual(original);
 const changed=structuredClone(edited);changed.bases[0]!.nature="requirement";expect(()=>buildClarificationCandidate(t,changed)).toThrow(/Only summary/);
 expect(()=>buildClarificationCandidate(t,{schemaVersion:3,reason:"Old result",reasonBasis:[{kind:"agent_inference",force:"interpretation",statement:"Old",scope:"Historical"}],operations:[]})).toThrow(/downgraded/);
});
it("reads prior result versions without translating or inventing new basis classifications",()=>{
 const p={schemaVersion:3,reason:"Historical",reasonBasis:[{kind:"material",force:"report",statement:"Historical statement",scope:"Historic",evidence:[{sourceId:"guide",chunkId:"c",quote:text}]}],operations:[]};
 expect(clarificationResultSchema.parse(p)).toEqual(p);expect(buildClarificationCandidate(task(),p).nextQuestion.groundingV4).toBeUndefined();
});
it.each([
 ["syntactically invalid",'{"reason":"Done"},"operations":[]}',"syntax","INVALID_JSON"],
 ["valid JSON with wrong schema",'{"schemaVersion":4,"reason":"Missing required fields"}',"schema","OUTPUT_SCHEMA_INVALID"],
 ["empty output","","provider","NO_STRUCTURED_OUTPUT"],
])("classifies %s and does not repair or retry",async(_label,raw,stage,code)=>{
 const t=task(),before=structuredClone(t),model=rawModel(raw),events:Record<string,unknown>[]=[];
 await expect(evaluateClarification(t,legacyResultRunner(model,60000,{onEvent:e=>events.push(e)}))).rejects.toMatchObject({diagnostic:{stage,code}});
 expect(events).toContainEqual(expect.objectContaining({type:"clarification_failed",diagnostic:expect.objectContaining({stage,code})}));expect(model.doGenerateCalls).toHaveLength(1);expect(t).toEqual(before);
});
it("classifies truncated provider output ahead of syntax and preserves the failure",async()=>{
 const model=rawModel('{"schemaVersion":4',"length");
 await expect(evaluateClarification(task(),legacyResultRunner(model))).rejects.toMatchObject({diagnostic:{stage:"provider",code:"OUTPUT_INCOMPLETE"}});expect(model.doGenerateCalls).toHaveLength(1);
});
it("redacts secrets and omits hidden-content markers from bounded syntax diagnostics",async()=>{
 const raw='{"apiKey":"project-secret","value":"sk-synthetic-token"},bad';
 try{await evaluateClarification(task(),legacyResultRunner(rawModel(raw),60000,{secrets:["project-secret"]}));throw Error("Expected syntax rejection");}
 catch(error){expect(error).toBeInstanceOf(ClarificationFailure);const d=classifyClarificationFailure(error);expect(d.stage).toBe("syntax");expect(d.position).toBeGreaterThan(0);expect(d.excerpt!.length).toBeLessThanOrEqual(240);expect(JSON.stringify(d)).not.toMatch(/project-secret|sk-synthetic-token/);}
 await expect(evaluateClarification(task(),legacyResultRunner(rawModel('{"reasoning_content":"private thoughts"},bad')))).rejects.toMatchObject({diagnostic:{stage:"syntax",excerpt:"[OMITTED: hidden-content marker]"}});
});
it("returns a bounded error code rather than provider messages or unknown exception contents",()=>{
 expect(classifyClarificationFailure(Object.assign(Error("sk-sensitive reasoning_content: hidden"),{name:"AI_APICallError"}))).toEqual({stage:"provider",code:"PROVIDER_REQUEST_FAILED"});
 expect(classifyClarificationFailure(Error("private unrelated exception"))).toEqual({stage:"execution",code:"ANALYSIS_FAILED"});
});

it("passes shared v4 bases and edited-wording caution to downstream positioning and deck contexts",async()=>{
 const {ResponsesPositioningRunner,buildDeterministicPositioning}=await import("./positioning-runner"),{ResponsesDeckRunner,buildDeterministicDeck}=await import("./deck-runner");
 const t=task();t.result=proposal();const edited=proposal();const op=edited.operations[1]!;if(op.type!=="update_summary")throw Error();op.text="My own revised goal.";
 const understanding=buildClarificationCandidate(t,edited),input={understandingVersionId:"v2",understanding,chunks:source.chunks},positioning=buildDeterministicPositioning(input),requests:any[]=[];
 const transport=(output:unknown)=>vi.fn(async(_url:unknown,init?:RequestInit)=>{requests.push(JSON.parse(String(init?.body)));return new Response(JSON.stringify({status:"completed",output:[{type:"message",content:[{type:"output_text",text:JSON.stringify(output)}]}]}),{status:200});});
 await new ResponsesPositioningRunner({apiKey:"offline",model:"offline",baseURL:"https://offline.invalid",fetch:transport(coreMessageWireFixture(positioning))}).run(input);
 const deckInput={...input,positioning,positioningVersionId:"p1",appliedDirectionId:positioning.directions[0]!.id};await new ResponsesDeckRunner({apiKey:"offline",model:"offline",baseURL:"https://offline.invalid",fetch:transport(liveDeckWireFixture(buildDeterministicDeck(deckInput),positioning.directions[0]!.coreMessage))}).run(deckInput);
 for(const request of requests){expect(request.input[0].content).toContain("material origin does not imply requirement");const context=JSON.parse(request.input[1].content),g=context.understanding.themes[0].summaryInterpretation.groundingV4;expect(g.reviewStatus).toBe("user_edited_unreviewed");expect(g.bases.find((b:any)=>b.id==="duration")).toMatchObject({origin:"material",nature:"suggestion",requirement:null});expect(context.understanding.nextQuestion.groundingV4.basisRefs).toEqual(["help","report"]);}
});

it("schema diagnostics retain issue paths and codes, not validation messages or returned values",async()=>{
 const p=proposal() as any;p.operations[1].basisRefs="sk-private-value";
 try{await evaluateClarification(task(),legacyResultRunner(scriptedClarificationModel(p)));throw Error("Expected schema rejection");}
 catch(error){const d=classifyClarificationFailure(error);expect(d.stage).toBe("schema");expect(d.issues?.some(i=>i.path.includes("operations.1.basisRefs"))).toBe(true);expect(JSON.stringify(d)).not.toContain("sk-private-value");}
});
it("the existing deadline also stops an offline provider that ignores abort, without a retry",async()=>{
 const model=new MockLanguageModelV4({doGenerate:async()=>new Promise(()=>{})}),t=task(),before=structuredClone(t);
 await expect(evaluateClarification(t,legacyResultRunner(model,25))).rejects.toMatchObject({diagnostic:{stage:"budget",code:"TIME_BUDGET"}});
 expect(model.doGenerateCalls).toHaveLength(1);expect(t).toEqual(before);
});
