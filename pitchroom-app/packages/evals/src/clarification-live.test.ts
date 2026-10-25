import { draftTestResultFromV4, groundedV4TestResult } from "../../agent/src/clarification-model.testkit";
import { afterEach,expect,it,vi } from "vitest";
import { mkdtempSync,readFileSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { type ClarificationResult,type UnderstandingProposalV1 } from "@pitchroom/domain";
import { type ClarifyLiveConfig } from "./clarification-budget";
import { initializeClarifySession,realCaseTask,runClarifyPhase,writeSummary } from "./clarification-live";
import { createSessionDirectory,LocalClarifyRecords,appRoot } from "./clarification-records";
const config:ClarifyLiveConfig={model:"offline-model-2026-01-01",baseURL:"https://offline.invalid/v1",inputUsdPerMillion:1,outputUsdPerMillion:1,countRequestMicroUsd:0,pricingSource:"https://offline.invalid/prices",pricingCheckedAt:"2026-10-24T00:00:00.000Z"};
const dirs:string[]=[];function records(max=2_000_000){const parent=mkdtempSync(join(tmpdir(),"clarify-records-"));dirs.push(parent);return new LocalClarifyRecords(createSessionDirectory(parent),max,["never-write-this-key"]);}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
function json(body:unknown,status=200){return new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});}
function scriptedResult(answer:string,base:UnderstandingProposalV1):ClarificationResult{
 // Test-only scripted semantics, never imported by the live CLI.
 if(answer.includes("认可")||answer.includes("不知道"))return {schemaVersion:2,reason:"Keep unknown; no further request.",operations:[]};
 const target=answer.includes("安全")?"T4":answer.includes("50%")?"T2":answer.includes("20%")||answer.includes("四周")?"T3":"T1";
 const text=target==="T4"?"用户只允许脱敏数据，审查未开始。":target==="T2"?"50%缺乏当前材料支持；样本不能代表所有客户。":target==="T3"?(answer.includes("自己的建议")?"20%是用户建议，采购未确认。":answer.includes("四周")?"四周准备与两周批准窗口冲突，需用户确认。":"用户转述20%目标，未达标不扩；基线未知。") :"面向采购负责人争取试点；权限未确认。";
 const operations:Extract<ClarificationResult,{schemaVersion:2}>["operations"]=[{type:"update_summary",themeId:target,text},{type:"add_answer",themeId:target}];
 if(answer.includes("自己的建议")){const prior=base.themes.find(t=>t.id===target)!.claims.find(c=>c.evidenceState==="user_asserted"&&c.statement.includes("20%"))!;operations.push({type:"supersede_user_assertion",themeId:target,claimId:prior.id!});}
 if(target==="T1")operations.push({type:"next_question",question:"试点的成功标准是什么？",whyItMatters:"决定是否扩大",relatedThemeIds:["T3"]});
 return {schemaVersion:2,reason:"Offline scripted output; not a model judgment.",operations};
}
function offlineTransport(){return vi.fn(async(url:unknown,init?:RequestInit)=>{
 if(String(url).endsWith("input_tokens"))return json({object:"response.input_tokens",input_tokens:500});
 const body=JSON.parse(String(init?.body));expect(body.store).toBe(false);expect(body.max_output_tokens).toBeLessThanOrEqual(2000);expect(init?.redirect).toBe("error");
 const user=body.input.find((m:{role:string})=>m.role==="user");const context=JSON.parse(user.content[0].text);
 return json({id:"response",created_at:1,model:body.model,status:"completed",usage:{input_tokens:500,output_tokens:100,total_tokens:600},output:[{type:"message",id:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(draftTestResultFromV4(groundedV4TestResult(scriptedResult(context.answer,context.base),context.base),context.base)),annotations:[]}]}]});});}
function approve(r:LocalClarifyRecords,id:string){const reviews=r.read<Record<string,{verdict:string;reviewer:string;checks:Record<string,string>;notes:string}>>("reviews.json");const item=reviews[id]!;item.verdict="pass";item.reviewer="offline-test-reviewer";item.notes="Synthetic mechanism test only";for(const key of Object.keys(item.checks))item.checks[key]="pass";r.write("reviews.json",reviews);}

it("records eight independent cases and requires real review gates before the actual-output chain",async()=>{
 const r=records();try{
 initializeClarifySession(r,config,"offline-provider");const fetch=offlineTransport();
 let report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.phase).toBe("awaiting_case1_review");expect(fetch).toHaveBeenCalledTimes(16);expect(report.outcomes).toHaveLength(8);expect(report.acceptedFirstRun).toBe(false);
 await runClarifyPhase(r,fetch,"never-write-this-key");expect(fetch).toHaveBeenCalledTimes(16);
 approve(r,"CLR-J01");report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.phase).toBe("awaiting_chain6_review");expect(fetch).toHaveBeenCalledTimes(18);
 await runClarifyPhase(r,fetch,"never-write-this-key");expect(fetch).toHaveBeenCalledTimes(18);
 approve(r,"chain-6");report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.phase).toBe("complete");expect(fetch).toHaveBeenCalledTimes(20);expect(report.budget?.tasks).toHaveLength(10);
 for(const item of report.outcomes)approve(r,item.id);
 report=writeSummary(r);expect(report.allCaseCriteriaMet).toBe(true);expect(report.acceptedFirstRun).toBe(false);expect(report.mode).toBe("offline-provider");
 const log=readFileSync(join(r.root,"events.jsonl"),"utf8");expect(log).not.toContain("never-write-this-key");expect(log).toContain("model_reserved");expect(log).toContain("usage_settled");
 const chain=r.read<{task:{base:UnderstandingProposalV1}}>("chain-7.json");expect(chain.task.base.themes[2]!.claims.some(c=>c.id?.startsWith("chain-6"))).toBe(true);
 }finally{r.close();}
});
it("stops a batch on a budget boundary and persists every unattempted case without retry",async()=>{
 const r=records();try{
 initializeClarifySession(r,config,"offline-provider");const fetch=vi.fn(async()=>json({object:"response.input_tokens",input_tokens:120001}));
 const report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.phase).toBe("stopped");expect(fetch).toHaveBeenCalledTimes(1);expect(report.budget?.modelRequests).toBe(0);expect(report.outcomes[0]!.status).toBe("execution_failed");expect(report.outcomes.slice(1).every(c=>c.status==="not_run_budget")).toBe(true);
 await expect(runClarifyPhase(r,fetch,"never-write-this-key")).rejects.toThrow("SESSION_CLOSED");expect(fetch).toHaveBeenCalledTimes(1);
 }finally{r.close();}
});
it("keeps old question and fresh material context for case eight",()=>{
 const t=realCaseTask("CLR-J08");expect(t.reassessment?.sourceChanges.added).toEqual(["client-window"]);expect(t.sources.at(-1)!.chunks[0]!.text).toContain("两周");expect(t.reassessment?.originalQuestion).toEqual(t.question);
});
it("records malformed output as execution failure, not a semantic or human pass",async()=>{
 const r=records();try{
 initializeClarifySession(r,config,"offline-provider");const fetch=vi.fn(async(url:unknown)=>String(url).endsWith("input_tokens")?json({object:"response.input_tokens",input_tokens:500}):json({id:"bad",model:config.model,status:"completed",usage:{input_tokens:500,output_tokens:1},output:[{id:"msg",type:"message",role:"assistant",content:[{type:"output_text",text:"not-json",annotations:[]}]}]}));
 const report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.outcomes[0]!.failure).toMatchObject({stage:"syntax",code:"INVALID_JSON"});expect(report.outcomes.slice(1).every(c=>c.status==="not_run_after_failure")).toBe(true);expect(report.phase).toBe("stopped");expect(report.acceptedFirstRun).toBe(false);expect(fetch).toHaveBeenCalledTimes(2);
 }finally{r.close();}
});
it("rejects concurrent writers, journal tampering and artifact exhaustion",()=>{
 const r=records();const root=r.root;
 expect(()=>new LocalClarifyRecords(root,2_000_000)).toThrow();r.event({type:"test",apiKey:"never-write-this-key",payload:"never-write-this-key",reasoning:{type:"reasoning",text:"hidden-thought"}});expect(readFileSync(join(root,"events.jsonl"),"utf8")).not.toMatch(/never-write-this-key|hidden-thought/);r.close();
 const saved=readFileSync(join(root,"events.jsonl"),"utf8");writeFileSync(join(root,"events.jsonl"),saved.replace('"test"','"tampered"'));expect(()=>new LocalClarifyRecords(root,2_000_000)).toThrow("INVALID_JOURNAL");
 const small=records(200);try{expect(()=>small.write("oversized.json",{text:"x".repeat(201)})).toThrow("ARTIFACT_BUDGET");}finally{small.close();}
});
it("the CLI with no explicit action cannot use even present credentials",()=>{
 const stdout=execFileSync(process.execPath,["--import","tsx","src/clarification-live-cli.ts"],{cwd:join(appRoot,"packages/evals"),env:{PATH:process.env.PATH,OPENAI_API_KEY:"never-write-this-key",PITCHROOM_LIVE_TRANSFER_ACK:"authorized"},encoding:"utf8"});
 expect(stdout).toContain("Default: no model calls");
});

it("restores consumed budgets after closing the process-local recorder",async()=>{
 let r=records();const root=r.root;initializeClarifySession(r,config,"offline-provider");const fetch=offlineTransport();await runClarifyPhase(r,fetch,"never-write-this-key");const before=r.lastBudget()!;approve(r,"CLR-J01");r.close();
 r=new LocalClarifyRecords(root,2_000_000,["never-write-this-key"]);try{const report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.budget!.httpRequests).toBe(before.httpRequests+2);expect(report.budget!.tasks).toHaveLength(9);expect(report.budget!.microUsd).toBeGreaterThan(before.microUsd);}finally{r.close();}
});
it("a failed human review blocks the chain without substituting a reference output",async()=>{
 const r=records();try{
  initializeClarifySession(r,config,"offline-provider");const fetch=offlineTransport();await runClarifyPhase(r,fetch,"never-write-this-key");
  const reviews=r.read<Record<string,{verdict:string}>>("reviews.json");reviews["CLR-J01"]!.verdict="fail";r.write("reviews.json",reviews);
  const report=await runClarifyPhase(r,fetch,"never-write-this-key");expect(report.phase).toBe("complete");expect(report.outcomes.slice(-2).every(o=>o.status==="blocked")).toBe(true);expect(fetch).toHaveBeenCalledTimes(16);expect(report.acceptedFirstRun).toBe(false);
 }finally{r.close();}
});
it("rejects configuration tampering and stale review hashes",async()=>{
 const r=records();try{
  initializeClarifySession(r,config,"offline-provider");const fetch=offlineTransport();await runClarifyPhase(r,fetch,"never-write-this-key");approve(r,"CLR-J01");
  const reviews=r.read<Record<string,{outputHash:string}>>("reviews.json");reviews["CLR-J01"]!.outputHash="wrong-output";r.write("reviews.json",reviews);
  await runClarifyPhase(r,fetch,"never-write-this-key");expect(fetch).toHaveBeenCalledTimes(16);
  const manifest=r.read<{config:{inputUsdPerMillion:number}}>("manifest.json");manifest.config.inputUsdPerMillion=0;r.write("manifest.json",manifest);
  await expect(runClarifyPhase(r,fetch,"never-write-this-key")).rejects.toThrow("MANIFEST_CHANGED");expect(fetch).toHaveBeenCalledTimes(16);
 }finally{r.close();}
});

it("DeepSeek runs the formal eight-case entry offline, records alias provenance and keeps the human chain gate",async()=>{
 const config:ClarifyLiveConfig={provider:"deepseek",model:"deepseek-flash",baseURL:"https://api.deepseek.com",observedVersion:"DeepSeek-V4.1-Flash-1017",reasoningEffort:"high",inputAccounting:"context-window-reservation",contextWindowTokens:1048576,inputUsdPerMillion:0.3,outputUsdPerMillion:1.2,countRequestMicroUsd:0,pricingSource:"https://api-docs.deepseek.com/quick_start/pricing/",pricingCheckedAt:"2026-10-25T00:00:00.000Z"};
 const r=records();try{
  initializeClarifySession(r,config,"offline-provider");const transport=offlineTransport();
  let report=await runClarifyPhase(r,transport,"never-write-this-key");expect(transport).toHaveBeenCalledTimes(8);expect(report.outcomes).toHaveLength(8);expect(report.phase).toBe("awaiting_case1_review");
  expect(report.accounting).toMatchObject({provider:"deepseek",inputLimitKind:"post-response-stop-threshold",versionPinned:false,observedVersion:config.observedVersion});
  await runClarifyPhase(r,transport,"never-write-this-key");expect(transport).toHaveBeenCalledTimes(8);
  approve(r,"CLR-J01");report=await runClarifyPhase(r,transport,"never-write-this-key");expect(transport).toHaveBeenCalledTimes(9);expect(report.phase).toBe("awaiting_chain6_review");
  approve(r,"chain-6");report=await runClarifyPhase(r,transport,"never-write-this-key");expect(transport).toHaveBeenCalledTimes(10);expect(report.phase).toBe("complete");expect(report.acceptedFirstRun).toBe(false);
  const log=readFileSync(join(r.root,"events.jsonl"),"utf8");expect(log).not.toContain("count_reserved");expect(log).not.toContain("never-write-this-key");
 }finally{r.close();}
});
