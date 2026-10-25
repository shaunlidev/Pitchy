import {afterEach,expect,it,vi} from "vitest";
import {mkdtempSync,readFileSync,readdirSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {ClarifyBudget,type ClarifyLiveConfig} from "./clarification-budget";
import {LocalClarifyRecords} from "./clarification-records";
import {httpErrorDiagnostic} from "./clarification-diagnostics";
import {initializeClarifySession,runClarifyPhase} from "./clarification-live";
const config:ClarifyLiveConfig={provider:"deepseek",model:"deepseek-flash",baseURL:"https://api.deepseek.com",observedVersion:"DeepSeek-V4.1-Flash-1017",reasoningEffort:"high",inputAccounting:"context-window-reservation",contextWindowTokens:1048576,inputUsdPerMillion:0.3,outputUsdPerMillion:1.2,countRequestMicroUsd:0,pricingSource:"https://api-docs.deepseek.com/quick_start/pricing/",pricingCheckedAt:"2026-10-25T00:00:00Z"};
const json=(data:unknown,status=400)=>new Response(JSON.stringify(data),{status});
const dirs:string[]=[];
function records(){const root=mkdtempSync(join(tmpdir(),"clarify-http-"));dirs.push(root);return new LocalClarifyRecords(root,2000000);}
afterEach(()=>{for(const dir of dirs.splice(0))rmSync(dir,{recursive:true,force:true});});
const init={headers:{authorization:"Bearer actual-key-not-sk-format"}};

it("keeps useful error fields, while excluding arbitrary payloads, keys and hidden thinking before journaling",async()=>{
 const diagnostic=await httpErrorDiagnostic(json({error:{type:"invalid_request_error",code:"invalid_schema",param:"text.format.schema",message:'Invalid oneOf. actual-key-not-sk-format Bearer other-token sk-other-key hidden-value secret-password',details:{password:"secret-password"}},reasoning_content:"hidden-value",output:[{type:"reasoning",content:"private-thought"}],headers:{authorization:"provider-auth-secret"}}),init,"generation");
 expect(diagnostic.body?.error).toMatchObject({type:"invalid_request_error",code:"invalid_schema",param:"text.format.schema"});
 expect(diagnostic.body?.error.message).toContain("Invalid oneOf");
 const encoded=JSON.stringify(diagnostic);expect(encoded).not.toMatch(/actual-key-not-sk-format|other-token|sk-other-key|hidden-value|secret-password|private-thought|provider-auth-secret/);
 const r=records();try{r.event({type:"http_error",diagnostic});r.write("diagnosis.json",diagnostic);expect(r.httpDiagnostics()[0]!.diagnostic).toEqual(diagnostic);for(const file of readdirSync(r.root).filter(p=>p!==".lock"))expect(readFileSync(join(r.root,file),"utf8")).not.toMatch(/private-thought|actual-key-not-sk-format/);}finally{r.close();}
});
it.each(['Invalid: <think>private-thought</think>','Invalid: {"reasoning_content":"private-thought"}','Invalid: {"thinking":"private-thought"}'])("omits an embedded hidden-thinking message rather than guessing delimiters: %s",async message=>{
 const d=await httpErrorDiagnostic(json({error:{message,code:"invalid_schema"}}),init,"generation");expect(d.body?.error.code).toBe("invalid_schema");expect(JSON.stringify(d)).not.toContain("private-thought");
});
it("redacts the actual credential before JSON escaping and before truncating a long message",async()=>{
 const key='nonstandard-"quoted-key';
 const d=await httpErrorDiagnostic(json({error:{message:"x".repeat(1990)+key+"z".repeat(300)}}),{headers:{authorization:`Bearer ${key}`}},"generation");
 expect(JSON.stringify(d)).not.toContain("quoted-key");expect(d.body?.error.message).toContain("[TRUNCATED]");
});
it.each([
 ["html",()=>new Response('<html>Bearer do-not-store <think>private</think></html>',{status:502}),"non_json"],
 ["oversized",()=>new Response("private".repeat(3000),{status:400}),"oversized"],
 ["primitive",()=>json("private"),"unrecognized_json"],
 ["unknown fields",()=>json({payload:"private",reasoning:{text:"private"}}),"no_allowed_error_fields"],
 ["broken stream",()=>new Response(new ReadableStream({start(c){c.error(new Error("private"));}}),{status:500}),"read_failed"],
] as const)("retains HTTP status but safely omits %s",async(_name,response,omitted)=>{
 const d=await httpErrorDiagnostic(response(),init,"generation");expect(d.bodyOmitted).toBe(omitted);expect(d.httpStatus).toBeGreaterThanOrEqual(400);expect(JSON.stringify(d)).not.toMatch(/private|do-not-store/);
});
it("handles provider string errors and root-level error fields",async()=>{
 expect((await httpErrorDiagnostic(json({error:"Invalid schema"}),init,"generation")).body?.error.message).toBe("Invalid schema");
 expect((await httpErrorDiagnostic(json({code:123,message:"Invalid schema"}),init,"generation")).body?.error.code).toBe("123");
});
it.each(["generation","token_count"] as const)("journals %s HTTP diagnostics and stops without retry or refund",async stage=>{
 const cfg:ClarifyLiveConfig=stage==="generation"?config:{model:"offline-2026-01-01",baseURL:"https://offline.invalid/v1",inputUsdPerMillion:1,outputUsdPerMillion:1,countRequestMicroUsd:10,pricingSource:"https://offline.invalid/pricing",pricingCheckedAt:"2026-10-25T00:00:00Z"};
 const events:Record<string,unknown>[]=[];const b=new ClarifyBudget(cfg,e=>events.push(e));b.beginTask("case");
 const transport=vi.fn(async()=>json({error:{message:"Bad schema",code:"invalid_schema"}}));
 const send=()=>b.fetch(transport)(`${cfg.baseURL}/responses`,{method:"POST",...init,body:JSON.stringify({model:cfg.model,input:"synthetic",tools:[]})});
 await expect(send()).rejects.toThrow(stage==="generation"?"MODEL_HTTP_ERROR":"TOKEN_COUNT_HTTP_ERROR");
 expect(events.find(e=>e.type==="http_error")).toMatchObject({taskId:"case",diagnostic:{stage,httpStatus:400,body:{error:{code:"invalid_schema"}}}});
 expect(b.state.microUsd).toBe(stage==="generation"?316973:10);await expect(send()).rejects.toThrow();expect(transport).toHaveBeenCalledTimes(1);
});
it("a failed diagnostic write still stops without a second request",async()=>{
 const b=new ClarifyBudget(config,e=>{if(e.type==="http_error")throw new Error("disk full");});b.beginTask("case");const transport=vi.fn(async()=>json({error:"Bad schema"}));
 await expect(b.fetch(transport)(`${config.baseURL}/responses`,{method:"POST",body:JSON.stringify({model:config.model,tools:[]})})).rejects.toThrow("RECORDING_FAILED");expect(b.state.microUsd).toBe(316973);expect(transport).toHaveBeenCalledTimes(1);
});
it("formal acceptance reports the sanitized failure and leaves the other seven cases unattempted",async()=>{
 const r=records();try{initializeClarifySession(r,config,"offline-provider");const transport=vi.fn(async()=>json({error:{code:"invalid_schema",param:"text.format.schema",message:"oneOf rejected"},reasoning_content:"private"}));
 const report=await runClarifyPhase(r,transport,"offline");expect(report.phase).toBe("stopped");expect(transport).toHaveBeenCalledTimes(1);expect(report.httpDiagnostics).toHaveLength(1);expect(report.httpDiagnostics[0]!.diagnostic.body.error.message).toBe("oneOf rejected");expect(report.outcomes[0]!.status).toBe("execution_failed");expect(report.outcomes[0]!.failure).toMatchObject({stage:"provider",code:"MODEL_HTTP_ERROR"});expect(report.outcomes.slice(1).every(o=>o.status==="not_run_after_failure")).toBe(true);expect(report.acceptedFirstRun).toBe(false);expect(readFileSync(join(r.root,"report.json"),"utf8")).not.toContain("private");
 }finally{r.close();}
});
