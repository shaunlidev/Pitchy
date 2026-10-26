import { expect,it } from "vitest";
import { newClarification,buildClarificationCandidate, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { clarificationDraftSchema,compileClarificationDraft } from "./clarification-draft";
import { clarificationModelContext,ModelClarificationRunner,evaluateClarification } from "./clarification-runner";
import { scriptedClarificationModel } from "./clarification-model.testkit";
const base:UnderstandingProposalV1={schemaVersion:1,themes:[{id:"goal",title:"Goal",summary:"Old plan",claims:[{id:"c1",statement:"A workshop is suggested.",evidenceState:"supported",evidence:[{sourceId:"s",chunkId:"chunk",quote:"A workshop is suggested."}],userInputIds:[]}]},{id:"metric",title:"Metric",summary:"Unknown metric",claims:[{id:"c2",statement:"Metric unknown",evidenceState:"unknown",evidence:[],userInputIds:[]}]}],gaps:[],nextQuestion:{question:"What is the goal?",whyItMatters:"Focus",relatedThemeIndexes:[0]}};
function task(){return newClarification({id:"task",inputId:"answer",projectId:"p",actorId:"u",commandId:"cmd",versionId:"v1",revision:1,base,sources:[{id:"s",projectId:"p",name:"guide",contentHash:"v1",mediaType:"text/plain",chunks:[{id:"chunk",sourceId:"s",text:"A workshop is suggested.",startOffset:0,endOffset:24}]}],answer:"This is a workshop, not a public launch."});}
function chineseTask(){const t=task();t.base.nextQuestion.question="这次目标是什么？";return t;}
function draft(){return {draftVersion:1,bases:[{id:"a",origin:"user",nature:"record",statement:"User proposes workshop",scope:"User report"},{id:"b",origin:"agent",nature:"interpretation",statement:"User plans a workshop, not a public launch; metric is unknown.",scope:"Suggestion only"}],basisRefs:["a"],changes:[{themeId:"goal",evidenceJudgments:[] as Array<{claim:string;verdict:"supported"|"unsupported"|"unconfirmed"|"conflicting";explanation:string}>,basisRefs:["a","b"],materialApplicability:[{claimId:"c1",status:"unconfirmed",currentInterpretation:"Workshop recommendation retained; arrangements unconfirmed",explanation:"User has not confirmed arrangements",basisRefs:["a"]}]}],corrections:[],question:{clauses:[{kind:"open",themeId:"metric",ask:"Which metric defines success?",unresolvedIssue:"Metric is unknown",expectedAnswer:"A success metric or explicit unknown"}],basisRefs:["b"]}};}
it("compiles one question representation to exact spans and scoped v4 operations without mutating draft",async()=>{
 const t=task(),d=draft(),before=structuredClone(d),events:Record<string,unknown>[]=[];const model=scriptedClarificationModel(d,"chunk");
 const out=await evaluateClarification(t,new ModelClarificationRunner(model,60000,{onEvent:e=>events.push(e)}));expect(d).toEqual(before);expect(model.doGenerateCalls).toHaveLength(2);const q=out.candidate.nextQuestion;expect(q.question).toBe(d.question.clauses[0]!.ask);expect(q.question).toContain(q.groundingV4!.associations[0]!.questionSpan);expect(q.relatedThemeIndexes).toEqual([1]);expect(q.whyItMatters).toContain("not a confirmed approval condition");expect(out.candidate.themes[1]).toEqual(t.base.themes[1]);expect(events).toContainEqual(expect.objectContaining({type:"draft_compiled",omittedBasisIds:[]}));
});
it("keeps an unreferenced draft basis in original evidence but omits it from compiled proposal",()=>{
 const t=task(),d=draft();d.bases.push({id:"unused",origin:"agent",nature:"record",statement:"Unused background",scope:"Unreferenced"} as any);const before=structuredClone(d),compiled=compileClarificationDraft(t,d);expect(compiled.omittedBasisIds).toEqual(["unused"]);expect(compiled.result.bases.map(b=>b.id)).toEqual(["a","b"]);expect(d).toEqual(before);expect(buildClarificationCandidate(t,compiled.result).themes[0]!.claims[0]).toEqual(t.base.themes[0]!.claims[0]);
});
it("rejects unknown fields instead of deleting them or repairing a malformed result",()=>{
 const d=draft() as any;d.question.clauses[0].basisRefs=[];expect(()=>compileClarificationDraft(task(),d)).toThrow();
});
it("task scoped schema rejects applicability from another theme, even if the ID exists",()=>{
 const d=draft();d.changes[0]!.materialApplicability[0]!.claimId="c2";expect(clarificationDraftSchema(task()).safeParse(d).success).toBe(false);
});
it("requires correction ownership and does not invent an updated summary for another theme",()=>{
 const d=draft();(d.corrections as string[]).push("c2");expect(()=>compileClarificationDraft(task(),d)).toThrow("CORRECTION_WITHOUT_CHANGE");
});
it("keeps no-change/unknown results possible without forcing a followup",()=>{
 const d={...draft(),changes:[],question:null,bases:[draft().bases[0]!]};const out=compileClarificationDraft(task(),d);expect(out.result.operations).toEqual([]);expect(buildClarificationCandidate(task(),out.result)).toEqual(task().base);
});
it("does not hide duplicate or missing basis IDs during canonicalization",()=>{
 const d=draft();d.bases.push(d.bases[0]!);expect(()=>compileClarificationDraft(task(),d)).toThrow("DUPLICATE_BASIS_ID");const missing=draft();missing.question.basisRefs=["absent"];expect(()=>compileClarificationDraft(task(),missing)).toThrow("INVALID_BASIS_REFERENCE");
});
it.each(["培训工作坊","数据库迁移","新品发布"])("keeps post-activity evaluation separate from approval and logistics for %s",activity=>{
 const d={...draft(),question:{clauses:[{kind:"success_criteria",themeId:"metric",activity}],basisRefs:["b"]}};
 const out=compileClarificationDraft(chineseTask(),d).result,op=out.operations.find(o=>o.type==="next_question")!;
 expect(op.question).toContain(`After ${activity}`);expect(op.question).toContain("observable results");expect(op.question).not.toMatch(/批准|采购|负责人|同意|才能/);
 expect(op.groundingV4.associations).toEqual([expect.objectContaining({themeId:"metric",questionSpan:op.question,expectedAnswer:`Observable results that define success after ${activity}, or an explicit unknown`})]);
 expect(op.groundingV4.associations[0]!.expectedAnswer).not.toMatch(/谁|时间|预算/);
});
it("asks baseline/method for an existing target without upgrading it to achieved performance",()=>{
 const d={...draft(),question:{clauses:[{kind:"measurement",themeId:"metric",target:"用户建议的错误率减少15%目标"}],basisRefs:["b"]}};
 const out=compileClarificationDraft(chineseTask(),d).result,op=out.operations.find(o=>o.type==="next_question")!;
 expect(op.question).toContain("what is the comparison baseline and how will it be measured");expect(op.question).toContain("用户建议");expect(op.question).not.toContain("已减少");expect(op.groundingV4.associations[0]!.questionSpan).toBe(op.question);
});
it("rejects a free-text approval question hidden alongside a typed evaluation inquiry",()=>{
 const d={...draft(),question:{clauses:[{kind:"success_criteria",themeId:"metric",activity:"培训",ask:"What must be done to secure approval?",expectedAnswer:"approval conditions"}],basisRefs:["b"]}};
 expect(()=>compileClarificationDraft(task(),d)).toThrow();
});
it("asks checkable evidence for a claimed outcome while retaining limited measured observations",()=>{
 const d={...draft(),question:{clauses:[{kind:"evidence_check",themeId:"metric",claim:"错误率下降70%",observedRecord:"6次观测从10降到8，代表性未知"}],basisRefs:["b"]}};
 const out=compileClarificationDraft(chineseTask(),d).result,op=out.operations.find(o=>o.type==="next_question")!;
 expect(op.question).toContain("checkable data or calculation");expect(op.question).toContain("6次观测从10降到8，代表性未知");expect(op.question).toContain("It is okay to have no further evidence");expect(op.question).not.toMatch(/已经证明|所有客户/);expect(op.groundingV4.associations[0]!.questionSpan).toBe(op.question);
});
it("accepts omitted inapplicable constraint metadata but never invents a requirement",()=>{
 const d=draft() as any;delete d.bases[0].requirement;delete d.bases[1].requirement;
 const out=compileClarificationDraft(task(),d).result;expect(out.bases.every(b=>b.requirement===null)).toBe(true);expect(()=>buildClarificationCandidate(task(),out)).not.toThrow();
 d.bases[0].nature="requirement";expect(()=>buildClarificationCandidate(task(),compileClarificationDraft(task(),d).result)).toThrow();
});
it("keeps an explicitly quoted user-reported requirement attributed and rejects agent-invented requirements",()=>{
 const t=task();t.answer="IT says a data review must finish before launch.";
 const d=draft() as any;d.bases[0]={...d.bases[0],nature:"requirement",statement:t.answer,requirement:{issuer:"IT (user report)",action:"Complete data review",condition:"Before launch",supportingQuote:t.answer}};
 const result=compileClarificationDraft(t,d).result;expect(()=>buildClarificationCandidate(t,result)).not.toThrow();expect(result.bases[0]).toMatchObject({origin:"user",nature:"requirement",requirement:{issuer:"IT (user report)"}});
 d.bases[0].origin="agent";delete d.bases[0].inputIds;expect(()=>compileClarificationDraft(t,d)).toThrow();
});
it("binds current user provenance from the task and preserves explicit historical provenance",()=>{
 const t=task();t.base.themes[0]!.claims.push({id:"prior",statement:"An earlier user plan",evidenceState:"user_asserted",evidence:[],userInputIds:["older-input"]});
 const d=draft() as any;d.bases.push({id:"history",origin:"history",nature:"record",statement:"An earlier user plan",scope:"Prior assertion",inputIds:["older-input"]});d.basisRefs.push("history");
 const out=compileClarificationDraft(t,d).result;expect(out.bases.find(b=>b.id==="a")).toMatchObject({origin:"user",inputIds:[t.inputId]});expect(out.bases.find(b=>b.id==="history")).toMatchObject({origin:"user",inputIds:["older-input"]});expect(()=>buildClarificationCandidate(t,out)).not.toThrow();
});
it("derives the visible summary from one interpretation and the scoped source-applicability explanations",()=>{
 const d=draft();d.bases[1]!.statement="Claimed improvement is unsupported by current material; observed sample is limited and future measurement remains unknown.";
 const out=compileClarificationDraft(task(),d).result,s=out.operations.find(o=>o.type==="update_summary")!;
 expect(s.text).toBe(out.bases.find(b=>b.id==="b")!.statement);expect(s.applicability).toEqual(d.changes[0]!.materialApplicability);
 const extra=draft() as any;extra.changes[0].text="A second version omits the evidence caveat";expect(()=>compileClarificationDraft(task(),extra)).toThrow();
 d.changes[0]!.basisRefs=["a"];expect(()=>compileClarificationDraft(task(),d)).toThrow("AMBIGUOUS_SUMMARY_BASIS");
});
it("requires an explicit evidence stance for disputed claims and renders it without case-specific values",()=>{
 const t=chineseTask();t.base.themes[0]!.claims[0]!.evidenceState="conflicting";const d=draft();
 const missing=clarificationDraftSchema(t).safeParse(d);expect(missing.success).toBe(false);if(!missing.success)expect(missing.error.issues).toContainEqual(expect.objectContaining({code:"too_small",path:["changes",0,"evidenceJudgments"]}));
 d.changes[0]!.evidenceJudgments.push({claim:"错误率下降70%",verdict:"unsupported",explanation:"有限观测未证明更强结果，不代表已证伪。"});
 const out=compileClarificationDraft(t,d).result,s=out.operations.find(o=>o.type==="update_summary")!;expect(s.text).toContain("current material does not support this claim");expect(s.text).toContain("错误率下降70%");expect(s.text).toContain("不代表已证伪");expect(s).not.toHaveProperty("evidenceJudgments");
});
it("separates material-applicability IDs from correctable user history in the model context",async()=>{
 const {clarificationModelContext}=await import("./clarification-runner");const t=task();t.base.themes[0]!.claims.push({id:"prior-user",statement:"Earlier attribution",evidenceState:"user_asserted",evidence:[],userInputIds:["earlier-input"]});
 const index=clarificationModelContext(t).referenceIndex;expect(index.materialClaimIdsByTheme.goal).toEqual(["c1"]);expect(index.correctableUserClaimIdsByTheme.goal).toEqual(["prior-user"]);
 const d=draft();d.changes[0]!.materialApplicability[0]!.claimId="prior-user";expect(clarificationDraftSchema(t).safeParse(d).success).toBe(false);
});
it("does not turn a context change into a verdict against the truth of a historical source record",()=>{
 const t=task(),d=draft();d.changes[0]!.evidenceJudgments.push({claim:t.base.themes[0]!.claims[0]!.statement,verdict:"unsupported",explanation:"The current audience changed"});
 expect(clarificationDraftSchema(t).safeParse(d).success).toBe(false);
});

it("keeps an English project's typed inquiry and compiler labels English while retaining full applicability",()=>{
 const t=task();const d={...draft(),question:{clauses:[{kind:"measurement",themeId:"metric",target:"user-suggested 20% reduction"}],basisRefs:["b"]}};
 const output=compileClarificationDraft(t,d).result;
 expect(JSON.stringify(output)).not.toMatch(/\p{Script=Han}/u);
 const summary=output.operations.find(o=>o.type==="update_summary")!;expect(summary.applicability).toEqual(d.changes[0]!.materialApplicability);
 const question=output.operations.find(o=>o.type==="next_question")!;expect(question.question).toContain("baseline");expect(question.question).toContain("user-suggested");expect(question.whyItMatters).toContain("not a confirmed approval condition");
});

it("keeps English clarification context and compiler explanations for saved Chinese questions and feedback",()=>{
 const t=chineseTask();t.answer="保持英文，重点说明证据。";const before=structuredClone(t);
 expect(clarificationModelContext(t)).toMatchObject({outputLanguage:"English",answer:t.answer});
 const out=compileClarificationDraft(t,draft()).result;
 expect(out.reason).toContain("review before applying");
 const q=out.operations.find(o=>o.type==="next_question")!;
 expect(q.whyItMatters).toContain("Suggested clarification:");
 expect(q.groundingV4.associations[0]!.rationale).toContain("This question directly asks for:");
 expect(t).toEqual(before);
});
