import { legacyResultRunner } from "../../agent/src/clarification-model.testkit";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { recordClaimCorrection, clarificationTaskSchema, type ClarificationResult, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { ModelClarificationRunner, evaluateClarification } from "../../agent/src/clarification-runner";
import { groundedTestResult, groundedV4TestResult, scriptedClarificationModel } from "../../agent/src/clarification-model.testkit";
import { createDatabase, PitchroomRepository } from "./repository";
import { ClarificationRepository } from "./clarification-repository";
import { userInputs } from "./schema";

const target=new URL(process.env.DATABASE_URL ?? "postgres://invalid");
if(!["localhost","127.0.0.1"].includes(target.hostname)||target.port!=="55437"||target.pathname!=="/clarify_qa"||target.username!=="clarify_qa")throw new Error("Structure integration requires the dedicated isolated clarify_qa database on localhost:55437.");
const database=createDatabase(process.env.DATABASE_URL!),repository=new PitchroomRepository(database.db),feedback=new ClarificationRepository(database.db);
beforeAll(async()=>{await migrate(database.db,{migrationsFolder:new URL("../migrations",import.meta.url).pathname});});
afterAll(()=>database.client.end());
async function current(id:string){return (await repository.getProject(id))!;}
async function seed(){
 const project=await repository.createProject("Synthetic structure QA");
 await repository.addMaterial(project.id,{name:"implementation.md",mediaType:"text/markdown",text:"One department. Four weeks suggested."},crypto.randomUUID());
 const [source]=(await repository.listSources(project.id));const chunk=source!.chunks[0]!;
 const claim={statement:chunk.text,evidenceState:"supported" as const,evidence:[{sourceId:source!.id,chunkId:chunk.id,quote:chunk.text}],userInputIds:[]};
 const base:UnderstandingProposalV1={schemaVersion:1,themes:[{id:"audience",title:"Audience",summary:"Decision unknown.",claims:[{...claim,id:"audience-source"}]},{id:"pilot",title:"Pilot",summary:"Four weeks suggested; target unknown.",claims:[{...claim,id:"pilot-source"}]}],gaps:[],nextQuestion:{question:"Who approves the pilot?",whyItMatters:"Decision scope",relatedThemeIndexes:[0]}};
 const run=await repository.createRun(project.id,crypto.randomUUID(),"synthetic-structure","offline-provider");await repository.completeRun({projectId:project.id,runId:run.id,expectedRevision:project.version,proposal:base});
 return {project:await current(project.id),base,source:source!};
}
async function submit(id:string,text:string,rebaseTaskId?:string){return feedback.submit({projectId:id,text,commandId:crypto.randomUUID(),expectedRevision:(await current(id)).version,actorId:"synthetic-user",rebaseTaskId});}
async function processTask(id:string,result:ClarificationResult){const claimed=(await feedback.claim("offline-provider","synthetic",id))!;expect(claimed).toBeDefined();const output=await evaluateClarification(claimed,legacyResultRunner(scriptedClarificationModel(groundedV4TestResult(result,claimed.base),claimed.sources[0]!.chunks[0]!.id)));await feedback.finish(claimed,output);return claimed;}
async function version(id:string){const p=await current(id);return (await repository.listVersions(id)).find(v=>v.id===p.currentUnderstandingId)!;}
describe("isolated PostgreSQL structure + formal runner offline",()=>{
 it("persists theme association, correction history and concurrent idempotent Apply across rounds",async()=>{
  const {project,base}=await seed();const id=project.id;
  const first=await submit(id,"Procurement agreed to a 20% target.");
  const result:ClarificationResult={schemaVersion:2,reason:"A reported pilot target, not achieved performance.",operations:[{type:"update_summary",themeId:"pilot",text:"User reports procurement agreed to a 20% target; measurement is open."},{type:"add_answer",themeId:"pilot"},{type:"next_question",question:"Which baseline?",whyItMatters:"Measurement remains open.",relatedThemeIds:["pilot"]}]};
  await processTask(id,result);await feedback.decide({projectId:id,taskId:first.id,action:"apply",commandId:crypto.randomUUID()});
  const v2=await version(id);expect(v2.proposal.nextQuestion.relatedThemeIndexes).toEqual([1]);
  const prior=v2.proposal.themes[1]!.claims.at(-1)!;
  const second=await submit(id,"20% was my suggestion; procurement has not agreed.");
  const claimed=(await feedback.claim("offline-provider","synthetic",id))!;
  const invalid:ClarificationResult={schemaVersion:2,reason:"Invalid source overwrite",operations:[{type:"supersede_user_assertion",themeId:"pilot",claimId:"pilot-source"},{type:"add_answer",themeId:"pilot"},{type:"update_summary",themeId:"pilot",text:"Wrong"}]};
  let rejected=false;try{await evaluateClarification(claimed,legacyResultRunner(scriptedClarificationModel(groundedV4TestResult(invalid,claimed.base))));}catch(error){rejected=true;await feedback.finish(claimed,undefined,String(error));}expect(rejected).toBe(true);
  expect((await feedback.list(id)).find(t=>t.id===second.id)!.status).toBe("failed");expect((await version(id)).id).toBe(v2.id);
  await feedback.decide({projectId:id,taskId:second.id,action:"retry",commandId:crypto.randomUUID()});
  const corrected:ClarificationResult={schemaVersion:2,reason:"The user withdraws prior attribution.",operations:[{type:"supersede_user_assertion",themeId:"pilot",claimId:prior.id!},{type:"update_summary",themeId:"pilot",text:"20% is a user suggestion. Procurement agreement remains unknown."},{type:"add_answer",themeId:"pilot"},{type:"next_question",question:"What would procurement agree to?",whyItMatters:"Unconfirmed target",relatedThemeIds:["pilot"]}]};
  await processTask(id,corrected);
  expect((await version(id)).proposal.themes[1]!.claims.at(-1)!.supersededBy).toBeUndefined();
  const decision={projectId:id,taskId:second.id,action:"apply" as const,commandId:crypto.randomUUID()};
  const [a,b]=await Promise.all([feedback.decide(decision),feedback.decide(decision)]);expect(a.resultVersionId).toBe(b.resultVersionId);
  const v3=await version(id);expect(v3.parentUnderstandingId).toBe(v2.id);expect(await repository.listVersions(id)).toHaveLength(3);
  expect(v3.proposal.themes[0]).toEqual(base.themes[0]);
  expect(v3.proposal.themes[1]!.claims.find(c=>c.id===prior.id)!.supersededBy).toEqual({inputId:second.inputId,taskId:second.id,replacementClaimId:`${second.id}:answer:pilot`});
  expect(v3.proposal.themes[1]!.claims.find(c=>c.id==="pilot-source")).toEqual(base.themes[1]!.claims[0]);
  const reopened=createDatabase(process.env.DATABASE_URL!);try{const tasks=await new ClarificationRepository(reopened.db).list(id);expect(clarificationTaskSchema.parse(tasks.at(-1))).toMatchObject({status:"applied",inputId:second.inputId});const saved=(await new PitchroomRepository(reopened.db).listVersions(id)).at(-1)!;expect(saved.proposal).toEqual(v3.proposal);}finally{await reopened.client.end();}
  const manual=structuredClone(v3.proposal);recordClaimCorrection(manual,1,manual.themes[1]!.claims.length-1,"Manual correction remains unconfirmed.","assigned-transactionally");
  const manualVersion=await repository.createUserVersion({projectId:id,expectedRevision:(await current(id)).version,kind:"correction",text:"Manual correction remains unconfirmed.",actorId:"synthetic-user",idempotencyKey:crypto.randomUUID(),proposal:manual});
  const replacement=manualVersion.proposal.themes[1]!.claims.at(-1)!;const priorActive=manualVersion.proposal.themes[1]!.claims.at(-2)!;
  expect(priorActive.supersededBy!.inputId).toBe(replacement.userInputIds[0]);expect(priorActive.supersededBy!.inputId).not.toBe("assigned-transactionally");expect(priorActive.statement).toBe(second.answer);

 });
 it("rejects stale Apply, rebuilds reassessment context from fresh sources and reuses the saved answer once",async()=>{
  const {project,base}=await seed();const id=project.id;
  const old=await submit(id,"Prepare a four-week pilot.");
  const result:ClarificationResult={schemaVersion:2,reason:"User preparation plan",operations:[{type:"update_summary",themeId:"pilot",text:"User plans four weeks."},{type:"add_answer",themeId:"pilot"}]};
  await processTask(id,result);
  const added=await repository.addMaterial(id,{name:"client-window.md",mediaType:"text/markdown",text:"Client approved only a two-week window."},crypto.randomUUID());
  await feedback.refresh(id);expect((await feedback.list(id))[0]!.status).toBe("stale");
  await expect(feedback.decide({projectId:id,taskId:old.id,action:"apply",commandId:crypto.randomUUID()})).rejects.toThrow(/changed/);
  // Material changes require a newly reviewed understanding before rebase.
  const before=await current(id),run=await repository.createRun(id,crypto.randomUUID(),"synthetic-refresh","offline-provider");
  const fresh=structuredClone(base);fresh.nextQuestion={question:"What is the measurement baseline?",whyItMatters:"Updated review",relatedThemeIndexes:[1]};
  await repository.completeRun({projectId:id,runId:run.id,expectedRevision:before.version,proposal:fresh});
  const commandId=crypto.randomUUID(),input={projectId:id,text:old.answer,expectedRevision:(await current(id)).version,commandId,actorId:"synthetic-user",rebaseTaskId:old.id};
  const [rebased,replayed]=await Promise.all([feedback.submit(input),feedback.submit(input)]);expect(rebased.id).toBe(replayed.id);expect(rebased.inputId).toBe(old.inputId);
  expect(rebased.reassessment).toEqual({rebasedFromTaskId:old.id,originalUnderstandingId:old.baseUnderstandingId,originalQuestion:old.question,sourceChanges:{added:[added.id],removed:[],changed:[]}});
  expect(rebased.question.question).toBe(fresh.nextQuestion.question);
  expect(await database.db.select().from(userInputs).where(eq(userInputs.projectId,id))).toHaveLength(1);
  await expect(feedback.submit({...input,rebaseTaskId:undefined})).rejects.toThrow(/different/);
  const output:ClarificationResult={schemaVersion:2,reason:"Preparation plan conflicts with new approval; user must decide.",operations:[{type:"update_summary",themeId:"pilot",text:"User's four-week preparation plan conflicts with the client's two-week approval; resolve before scheduling."},{type:"add_answer",themeId:"pilot"},{type:"next_question",question:"How should the preparation plan fit the approved window?",whyItMatters:"No automatic compromise",relatedThemeIds:["pilot"]}]};
  const claim=await processTask(id,output);
  const applied=await feedback.decide({projectId:id,taskId:rebased.id,action:"apply",commandId:crypto.randomUUID()});
  expect((await version(id)).proposal.nextQuestion.relatedThemeIndexes).toEqual([1]);expect(applied.resultVersionId).toBeDefined();expect(claim.reassessment).toEqual(rebased.reassessment);
  const historical=(await feedback.list(id)).find(t=>t.id===old.id)!;expect(historical.status).toBe("stale");expect(historical.result).toEqual(groundedV4TestResult(result,old.base));expect(historical.answer).toBe(old.answer);
 });
});

it("v3 survives PostgreSQL reopen and edited/idempotent Apply without endorsing user wording",async()=>{
 const {project}=await seed(),id=project.id;
 const saved=await submit(id,"Current goal is a bounded experiment; launch approval is unconfirmed.");
 const result=groundedTestResult({schemaVersion:2,reason:"Current user goal is separate from the material's suggested plan.",operations:[{type:"add_answer",themeId:"pilot"},{type:"update_summary",themeId:"pilot",text:"User proposes an experiment. Six-week approval conditions remain unknown."},{type:"next_question",question:"What outcome counts as success?",whyItMatters:"A criterion would help evaluation; approval conditions remain unknown.",relatedThemeIds:["pilot"]}]},saved.base);
 const basis={kind:"user_report" as const,force:"report" as const,statement:saved.answer,scope:"User's current discussion",inputIds:[saved.inputId]};
 result.reasonBasis=[basis];const summary=result.operations.find(op=>op.type==="update_summary")!;summary.basis=[basis];summary.applicability[0]!.basis=[basis];summary.applicability[0]!.status="differs";
 const originalVersion=await version(id);const claimedV3=(await feedback.claim("offline-legacy","synthetic",id))!;
 await feedback.finish(claimedV3,await evaluateClarification(claimedV3,{run:async()=>result}));
 const reopened=createDatabase(process.env.DATABASE_URL!);
 try{
  const freshFeedback=new ClarificationRepository(reopened.db);const read=clarificationTaskSchema.parse((await freshFeedback.list(id)).find(t=>t.id===saved.id));
  expect(read.result).toEqual(result);expect(read.candidate!.nextQuestion.grounding!.objective).toBeDefined();expect((await version(id)).id).toBe(originalVersion.id);
  await expect(freshFeedback.decide({projectId:id,taskId:saved.id,action:"apply",commandId:crypto.randomUUID(),result:{schemaVersion:2,reason:"Downgrade",operations:[]}})).rejects.toThrow(/downgraded/);
  const tampered=structuredClone(result);tampered.reason="Confirmed";
  await expect(freshFeedback.decide({projectId:id,taskId:saved.id,action:"apply",commandId:crypto.randomUUID(),result:tampered})).rejects.toThrow(/Only summary/);
  const edited=structuredClone(result);const op=edited.operations.find(o=>o.type==="update_summary")!;op.text="My own revised interpretation, still unverified.";
  const command={projectId:id,taskId:saved.id,action:"apply" as const,commandId:crypto.randomUUID(),result:edited};
  const [a,b]=await Promise.all([freshFeedback.decide(command),freshFeedback.decide(command)]);expect(a.resultVersionId).toBe(b.resultVersionId);
  const after=await version(id),metadata=after.proposal.themes[1]!.summaryInterpretation!;
  expect(metadata.grounding!.reviewStatus).toBe("user_edited_unreviewed");expect(metadata.explanation).toContain("not been reassessed");expect(metadata.inputIds).toEqual([saved.inputId]);
  expect(after.proposal.themes[1]!.claims[0]).toEqual(saved.base.themes[1]!.claims[0]);expect(await repository.listVersions(id)).toHaveLength(2);
  const reread=(await freshFeedback.list(id)).find(t=>t.id===saved.id)!;expect(reread.result).toEqual(result);expect(reread.appliedResult).toEqual(edited);
 }finally{await reopened.client.end();}
});
it("v3 invalid references fail offline analysis while saved answer and current version remain intact",async()=>{
 const {project}=await seed(),id=project.id,saved=await submit(id,"The decision is still open.");
 const claimed=(await feedback.claim("offline-provider","synthetic",id))!;
 const result=groundedTestResult({schemaVersion:2,reason:"Unknown",operations:[]},claimed.base);
 result.reasonBasis=[{kind:"user_report",force:"report",statement:"Fabricated input",scope:"Synthetic",inputIds:["absent"]}];
 const before=await version(id);
 try{await evaluateClarification(claimed,{run:async()=>result});throw Error("Expected invalid reference rejection");}
 catch(error){expect(String(error)).toContain("Unknown or superseded");await feedback.finish(claimed,undefined,String(error));}
 const read=(await feedback.list(id)).find(t=>t.id===saved.id)!;
 expect(read.status).toBe("failed");expect(read.answer).toBe(saved.answer);expect(read.result).toBeUndefined();expect((await version(id)).id).toBe(before.id);
});

it("v4 persists unified references, original records and user edits across connections and idempotent Apply",async()=>{
 const {project}=await seed(),id=project.id,saved=await submit(id,"A workshop first; sponsor agreement remains unconfirmed.");
 const output=groundedV4TestResult({schemaVersion:2,reason:"Attributed workshop plan; material recommendations remain separate.",operations:[{type:"add_answer",themeId:"pilot"},{type:"update_summary",themeId:"pilot",text:"User suggests a workshop; duration and sponsor agreement are unconfirmed."},{type:"next_question",question:"What outcome would count as success?",whyItMatters:"Could help evaluate the workshop",relatedThemeIds:["pilot"]}]},saved.base);
 // Explicitly exercise independent provenance + modality in real JSONB payloads.
 const c=saved.sources[0]!.chunks[0]!;
 output.bases.push({id:"guide-suggestion",origin:"material",nature:"suggestion",requirement:null,statement:"Material suggests four weeks.",scope:"Material recommendation; not an approval condition",evidence:[{sourceId:c.sourceId,chunkId:c.id,quote:c.text}]});
 output.reasonBasisRefs.push("guide-suggestion");const s=output.operations.find(o=>o.type==="update_summary")!;s.basisRefs.push("guide-suggestion");s.applicability[0]!.basisRefs.push("guide-suggestion");
 const old=await version(id);await processTask(id,output);expect((await version(id)).id).toBe(old.id);
 const reopened=createDatabase(process.env.DATABASE_URL!);
 try{
  const store=new ClarificationRepository(reopened.db),fresh=(await store.list(id)).find(t=>t.id===saved.id)!;
  expect(clarificationTaskSchema.parse(fresh).result).toEqual(output);expect(fresh.candidate!.themes[1]!.summaryInterpretation!.groundingV4!.bases.find(b=>b.id==="guide-suggestion")!.nature).toBe("suggestion");
  const tampered=structuredClone(output);tampered.bases.at(-1)!.nature="requirement";
  await expect(store.decide({projectId:id,taskId:saved.id,action:"apply",commandId:crypto.randomUUID(),result:tampered})).rejects.toThrow(/Only summary/);
  const edited=structuredClone(output);edited.operations.find(o=>o.type==="update_summary")!.text="My own revised workshop plan.";
  const cmd={projectId:id,taskId:saved.id,action:"apply" as const,commandId:crypto.randomUUID(),result:edited};const [a,b]=await Promise.all([store.decide(cmd),store.decide(cmd)]);expect(a.resultVersionId).toBe(b.resultVersionId);
  const current=await version(id),g=current.proposal.themes[1]!.summaryInterpretation!.groundingV4!;
  expect(g.reviewStatus).toBe("user_edited_unreviewed");expect(g.bases.find(b=>b.id==="guide-suggestion")!.nature).toBe("suggestion");expect(current.proposal.themes[1]!.claims[0]).toEqual(saved.base.themes[1]!.claims[0]);expect(current.proposal.nextQuestion.groundingV4!.associations[0]!.questionSpan).toBe("What outcome would count as success?");expect(await repository.listVersions(id)).toHaveLength(2);
  const history=(await store.list(id)).find(t=>t.id===saved.id)!;expect(history.result).toEqual(output);expect(history.appliedResult).toEqual(edited);
 }finally{await reopened.client.end();}
});
it("persists classified v4 syntax failure with saved answer, no candidate, and no implicit retry",async()=>{
 const {project}=await seed(),id=project.id,saved=await submit(id,"Metric remains unknown.");
 const claimed=(await feedback.claim("offline-provider","synthetic",id))!,before=await version(id);
 const {rawClarificationModel}=await import("../../agent/src/clarification-model.testkit");const {classifyClarificationFailure}=await import("../../agent/src/clarification-failure");
 const model=rawClarificationModel('{"reason":"Closed early"},"operations":[]}');
 try{await evaluateClarification(claimed,legacyResultRunner(model));throw Error("Expected syntax failure");}
 catch(error){const failure=classifyClarificationFailure(error);expect(failure).toMatchObject({stage:"syntax",code:"INVALID_JSON"});await feedback.finish(claimed,undefined,failure.code,failure);}
 const reopened=createDatabase(process.env.DATABASE_URL!);try{
  const store=new ClarificationRepository(reopened.db),task=(await store.list(id)).find(t=>t.id===saved.id)!;expect(clarificationTaskSchema.parse(task).attempts.at(-1)!.failure).toMatchObject({stage:"syntax",code:"INVALID_JSON"});expect(task.attempts).toHaveLength(1);expect(task.answer).toBe(saved.answer);expect(task.candidate).toBeUndefined();expect(task.status).toBe("failed");expect(await store.claim("offline-provider","synthetic",id)).toBeUndefined();expect((await version(id)).id).toBe(before.id);expect(model.doGenerateCalls).toHaveLength(1);
 }finally{await reopened.client.end();}
});
it("default draft compiler persists a post-activity inquiry across reopen and explicit Apply",async()=>{
 const {project}=await seed(),id=project.id,saved=await submit(id,"We plan a training workshop; success criteria are unknown.");
 const claimed=(await feedback.claim("offline-default-draft","synthetic",id))!,before=await version(id);
 const draft={draftVersion:1,bases:[{id:"u",origin:"user",nature:"record",statement:saved.answer,scope:"Saved user report"},{id:"summary",origin:"agent",nature:"interpretation",statement:"User proposes a training workshop. Success criteria and duration remain unconfirmed.",scope:"Current pilot understanding"}],basisRefs:["u"],changes:[{themeId:"pilot",evidenceJudgments:[],basisRefs:["u","summary"],materialApplicability:[{claimId:"pilot-source",status:"unconfirmed",currentInterpretation:"Four weeks remains a material suggestion",explanation:"User has not confirmed duration",basisRefs:["u"]}]}],corrections:[],question:{clauses:[{kind:"success_criteria",themeId:"pilot",activity:"training workshop"}],basisRefs:["u"]}};
 const result=await evaluateClarification(claimed,new ModelClarificationRunner(scriptedClarificationModel(draft)));await feedback.finish(claimed,result);
 expect((await version(id)).id).toBe(before.id);
 const reopened=createDatabase(process.env.DATABASE_URL!);try{
  const store=new ClarificationRepository(reopened.db),read=(await store.list(id)).find(t=>t.id===saved.id)!;
  expect(read.result).toEqual(result.result);expect(read.candidate!.nextQuestion.question).toContain("After training workshop");expect(read.candidate!.nextQuestion.question).not.toMatch(/批准|同意|才能/);
  expect(read.candidate!.nextQuestion.groundingV4!.associations[0]!.questionSpan).toBe(read.candidate!.nextQuestion.question);
  const command={projectId:id,taskId:saved.id,action:"apply" as const,commandId:crypto.randomUUID()};await store.decide(command);const replay=await store.decide(command);
  expect(replay.resultVersionId).toBe((await version(id)).id);expect((await version(id)).proposal.themes[0]).toEqual(saved.base.themes[0]);expect((await version(id)).proposal.themes[1]!.claims[0]).toEqual(saved.base.themes[1]!.claims[0]);
 }finally{await reopened.client.end();}
});
