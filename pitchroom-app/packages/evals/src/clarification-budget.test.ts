import { expect,it,vi } from "vitest";
import { createModelClarificationRunner,evaluateClarification } from "@pitchroom/agent";
import { ClarifyBudget,clarifyLimits,clarifyLiveConfigSchema,type BudgetState,type ClarifyLiveConfig } from "./clarification-budget";
import { taskForCase,clarifyCases } from "./clarification-cases";
export const config:ClarifyLiveConfig={model:"offline-model-2026-01-01",baseURL:"https://offline.invalid/v1",inputUsdPerMillion:1,outputUsdPerMillion:1,countRequestMicroUsd:0,pricingSource:"https://offline.invalid/prices",pricingCheckedAt:"2026-10-24T00:00:00.000Z"};
export const json=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{"content-type":"application/json"}});
const body=()=>({model:config.model,input:"synthetic",tools:[],max_output_tokens:99999});
const request=(budget:ClarifyBudget,transport:typeof fetch)=>budget.fetch(transport)(`${config.baseURL}/responses`,{method:"POST",body:JSON.stringify(body())});
const zero=():BudgetState=>({tasks:[],steps:{},httpRequests:0,modelRequests:0,inputTokens:0,outputTokens:0,microUsd:0});
const mock=(input=100,output=10)=>vi.fn(async(url:unknown)=>String(url).endsWith("input_tokens")?json({object:"response.input_tokens",input_tokens:input}):json({model:config.model,status:"completed",usage:{input_tokens:input,output_tokens:output},output:[]}));

it("requires a pinned snapshot, explicit rates and bounded approved limits",()=>{
 expect(()=>clarifyLiveConfigSchema.parse({...config,model:"latest"})).toThrow();expect(()=>clarifyLiveConfigSchema.parse({...config,inputUsdPerMillion:-1})).toThrow();expect(()=>clarifyLiveConfigSchema.parse({...config,baseURL:"http://localhost/v1"})).toThrow();
 expect(clarifyLimits).toMatchObject({tasks:10,httpRequests:60,inputTokens:120000,outputTokens:20000,microUsd:3000000});
});
it("counts before dispatch, reserves costs and caps total generated tokens",async()=>{
 const events:Record<string,unknown>[]=[];const b=new ClarifyBudget(config,e=>events.push(e));b.beginTask("case");const fetch=mock();await request(b,fetch);
 expect(fetch).toHaveBeenCalledTimes(2);expect(b.state).toMatchObject({httpRequests:2,modelRequests:1,inputTokens:100,outputTokens:10,microUsd:110});
 const reservation=events.find(e=>e.type==="model_reserved")!;expect((reservation.budget as BudgetState).outputTokens).toBe(2000);
 const calls=fetch.mock.calls as unknown as Array<[string,RequestInit]>; // Inspect the request through a separate transport below.
 expect(calls[0]![0]).toContain("input_tokens");
});
it.each([
 ["HTTP_BUDGET",{httpRequests:59},0],
 ["INPUT_TOKEN_BUDGET",{inputTokens:120000},0],
 ["OUTPUT_TOKEN_BUDGET",{outputTokens:20000},0],
 ["COST_BUDGET",{microUsd:3000000},0],
] as const)("stops at %s without sending another model request",async(code,patch,expectedCount)=>{
 const b=new ClarifyBudget(config,()=>{}, {...zero(),...patch});b.beginTask("case");const fetch=mock();await expect(request(b,fetch)).rejects.toThrow(code);expect(fetch).toHaveBeenCalledTimes(expectedCount);expect(b.state.modelRequests).toBe(0);await expect(request(b,fetch)).rejects.toThrow(code);expect(fetch).toHaveBeenCalledTimes(expectedCount);
});
it("stops after counting if input or cost reservation cannot fit",async()=>{
 for(const [patch,code] of [[{inputTokens:119950},"INPUT_TOKEN_BUDGET"],[{microUsd:2999999},"COST_BUDGET"]] as const){const b=new ClarifyBudget(config,()=>{},{...zero(),...patch});b.beginTask("case");const fetch=mock();await expect(request(b,fetch)).rejects.toThrow(code);expect(fetch).toHaveBeenCalledTimes(1);}
});
it("bounds tasks and per-task steps across a restored ledger",async()=>{
 const b=new ClarifyBudget(config,()=>{});for(let i=0;i<10;i++)b.beginTask(`case-${i}`);expect(()=>b.beginTask("eleventh")).toThrow("TASK_BUDGET");
 const restored=new ClarifyBudget(config,()=>{},{...zero(),tasks:["old"],steps:{old:6},httpRequests:12,modelRequests:6});restored.beginTask("new");const fetch=mock();for(let i=0;i<6;i++)await request(restored,fetch);await expect(request(restored,fetch)).rejects.toThrow("STEP_BUDGET");expect(fetch).toHaveBeenCalledTimes(12);
});
it.each(["missing","http","network","mismatch","oversized"])("does not refund an ambiguous %s response or continue",async(mode)=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");const fetch=vi.fn(async(url:unknown)=>{
  if(String(url).endsWith("input_tokens"))return json({object:"response.input_tokens",input_tokens:100});
  if(mode==="network")throw new Error("secret credential should not be logged");
  if(mode==="oversized")return new Response("x".repeat(1_000_001));
  return json({model:config.model,status:"completed",usage:mode==="missing"?undefined:{input_tokens:101,output_tokens:2},output:[]},mode==="http"?429:200);
 });await expect(request(b,fetch)).rejects.toThrow();expect(b.state).toMatchObject({inputTokens:100,outputTokens:2000,microUsd:2100,modelRequests:1});await expect(request(b,fetch)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
});
it("fails closed when token counting is unavailable",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");const fetch=vi.fn(async()=>json({error:"not supported"},404));await expect(request(b,fetch)).rejects.toThrow("TOKEN_COUNT_HTTP_ERROR");expect(b.state.modelRequests).toBe(0);expect(fetch).toHaveBeenCalledTimes(1);
});
it("never dispatches when durable reservation recording fails",async()=>{
 const b=new ClarifyBudget(config,e=>{if(e.type==="model_reserved")throw new Error("Disk full");});b.beginTask("case");const fetch=mock();await expect(request(b,fetch)).rejects.toThrow("RECORDING_FAILED");expect(fetch).toHaveBeenCalledTimes(1);
});
it("the real SDK runner does not retry a transient provider response",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");const fetch=vi.fn(async(url:unknown)=>String(url).endsWith("input_tokens")?json({object:"response.input_tokens",input_tokens:100}):json({error:{type:"server_error",message:"synthetic"}},503));
 const runner=createModelClarificationRunner({...config,apiKey:"offline-key",fetch:b.fetch(fetch),maxOutputTokens:2000});
 await expect(evaluateClarification(taskForCase(clarifyCases[0]!),runner)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(2);
});
it("rejects redirects, unsupported endpoints and model changes before transfer",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");const fetch=mock();await expect(b.fetch(fetch)("https://other.invalid/v1/responses",{method:"POST",body:JSON.stringify(body())})).rejects.toThrow("UNEXPECTED_ENDPOINT");expect(fetch).not.toHaveBeenCalled();
});

it("disables SDK implicit retries even without the budget transport",async()=>{
 const fetch=vi.fn(async()=>json({error:{type:"server_error",message:"offline transient",code:"server_error",param:null}},503));
 const runner=createModelClarificationRunner({...config,apiKey:"offline-key",fetch,maxOutputTokens:2000});
 await expect(evaluateClarification(taskForCase(clarifyCases[0]!),runner)).rejects.toThrow();expect(fetch).toHaveBeenCalledTimes(1);
});
it("validates output cap, token-count payload and reservation ordering at the transport boundary",async()=>{
 const events:Record<string,unknown>[]=[];const b=new ClarifyBudget(config,e=>events.push(e));b.beginTask("case");
 const fetch=vi.fn(async(url:unknown,init?:RequestInit)=>{
  const payload=JSON.parse(String(init!.body));expect(init?.redirect).toBe("error");
  if(String(url).endsWith("input_tokens")){expect(payload).not.toHaveProperty("max_output_tokens");return json({object:"response.input_tokens",input_tokens:100});}
  expect(events.at(-1)!.type).toBe("model_reserved");expect(payload.max_output_tokens).toBe(2000);expect(payload.store).toBe(false);return json({model:config.model,usage:{input_tokens:100,output_tokens:10},output:[]});
 });await request(b,fetch);
});

it("a concurrent request stop prevents an already pending count from dispatching generation",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");let resolveCount!:(r:Response)=>void;
 const fetch=vi.fn(()=>new Promise<Response>(resolve=>{resolveCount=resolve;}));const first=request(b,fetch);
 await expect(request(b,fetch)).rejects.toThrow("CONCURRENT_REQUEST_FORBIDDEN");resolveCount(json({object:"response.input_tokens",input_tokens:100}));
 await expect(first).rejects.toThrow("CONCURRENT_REQUEST_FORBIDDEN");expect(fetch).toHaveBeenCalledTimes(1);expect(b.state.modelRequests).toBe(0);
});
