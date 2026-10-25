import { expect, it, vi } from "vitest";
import { createModelClarificationRunner, evaluateClarification } from "@pitchroom/agent";
import { ClarifyBudget, clarifyLiveConfigSchema, type BudgetState, type ClarifyLiveConfig } from "./clarification-budget";
import { clarifyCases, taskForCase } from "./clarification-cases";

const config: ClarifyLiveConfig = {
  provider: "deepseek", model: "deepseek-flash", baseURL: "https://api.deepseek.com",
  observedVersion: "DeepSeek-V4.1-Flash-1017", reasoningEffort: "high",
  inputAccounting: "context-window-reservation", contextWindowTokens: 1_048_576,
  inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20, countRequestMicroUsd: 0,
  pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingCheckedAt: "2026-10-25T00:00:00.000Z",
};
const json = (data: unknown, status=200) => new Response(JSON.stringify(data), {status,headers:{"content-type":"application/json"}});
const empty = (): BudgetState => ({tasks:[],steps:{},httpRequests:0,modelRequests:0,inputTokens:0,outputTokens:0,microUsd:0});
const send = (b: ClarifyBudget, transport: typeof fetch) => b.fetch(transport)(`${config.baseURL}/responses`,{method:"POST",body:JSON.stringify({model:config.model,input:"synthetic",tools:[]})});
const result = (input=500, output=100) => ({model:"deepseek-flash",status:"completed",usage:{input_tokens:input,output_tokens:output,output_tokens_details:{reasoning_tokens:80}},output:[]});

it("accepts only the reviewed DeepSeek endpoint, alias, accounting and peak ceilings",()=>{
 expect(clarifyLiveConfigSchema.parse(config)).toEqual(config);
 for(const patch of [{provider:undefined},{model:"DeepSeek-V4.1-Flash-1017"},{baseURL:"https://other.invalid"},{baseURL:"https://api.deepseek.com/v1"},{observedVersion:"unknown"},{inputUsdPerMillion:0.15},{outputUsdPerMillion:0.6},{contextWindowTokens:100},{reasoningEffort:"none"},{countRequestMicroUsd:1}]){
  expect(()=>clarifyLiveConfigSchema.parse({...config,...patch})).toThrow();
 }
});
it("reserves whole-context peak cost before transfer, sends no count, and settles inclusive reasoning usage",async()=>{
 const events:Record<string,unknown>[]=[];const b=new ClarifyBudget(config,e=>events.push(e));b.beginTask("case");
 const transport=vi.fn(async(url:unknown,init?:RequestInit)=>{
  expect(url).toBe("https://api.deepseek.com/responses");expect(init?.redirect).toBe("error");
  expect(JSON.parse(String(init?.body))).toMatchObject({reasoning:{effort:"high"},max_output_tokens:2000,store:false});
  expect(events.at(-1)).toMatchObject({type:"model_reserved",inputAccounting:"context-window-reservation",reserved:{inputTokens:1048576,outputTokens:2000,microUsd:316973}});
  return json(result());
 });await send(b,transport);expect(transport).toHaveBeenCalledTimes(1);
 expect(b.state).toMatchObject({inputTokens:500,outputTokens:100,microUsd:270,modelRequests:1,httpRequests:1});
 expect(events.some(e=>String(e.type).startsWith("count_"))).toBe(false);
});
it("does not send when a whole-context cost reservation will exceed the dollar cap",async()=>{
 const b=new ClarifyBudget(config,()=>{},{...empty(),microUsd:2_700_000});b.beginTask("case");const transport=vi.fn();
 await expect(send(b,transport)).rejects.toThrow("COST_BUDGET");expect(transport).not.toHaveBeenCalled();
});
it("stops after crossing the input threshold and restores that stopped ledger without refund or retry",async()=>{
 const b=new ClarifyBudget(config,()=>{},{...empty(),inputTokens:119900});b.beginTask("case");const transport=vi.fn(async()=>json(result()));
 await expect(send(b,transport)).rejects.toThrow("INPUT_TOKEN_BUDGET");expect(b.state.inputTokens).toBe(120400);
 const restored=new ClarifyBudget(config,()=>{},structuredClone(b.state));
 expect(()=>restored.beginTask("next")).toThrow("INPUT_TOKEN_BUDGET");await expect(send(restored,transport)).rejects.toThrow("INPUT_TOKEN_BUDGET");expect(transport).toHaveBeenCalledTimes(1);
});
it.each(["network","missing","http","identity","input-overrun","output-overrun"])("retains unknown or invalid %s charges and never retries",async(mode)=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");
 const transport=vi.fn(async()=>{if(mode==="network")throw new Error("offline");const payload:Record<string,unknown>=result(mode==="input-overrun"?1048577:500,mode==="output-overrun"?2001:100);
  if(mode==="missing")delete payload.usage;if(mode==="identity")payload.model="changed-model";return json(payload,mode==="http"?503:200);
 });await expect(send(b,transport)).rejects.toThrow();
 expect(b.state).toMatchObject({inputTokens:1048576,outputTokens:2000,microUsd:316973});
 const restored=new ClarifyBudget(config,()=>{},structuredClone(b.state));await expect(send(restored,transport)).rejects.toThrow();expect(transport).toHaveBeenCalledTimes(1);
});
it("preserves the 30-generation ceiling when there are no count requests",async()=>{
 const state={...empty(),tasks:["a","b","c","d","e"],steps:{a:6,b:6,c:6,d:6,e:6},modelRequests:30,httpRequests:30};
 const b=new ClarifyBudget(config,()=>{},state);b.beginTask("last");const transport=vi.fn();await expect(send(b,transport)).rejects.toThrow("MODEL_REQUEST_BUDGET");expect(transport).not.toHaveBeenCalled();
});
it("caps the last output reservation at the remaining round allowance",async()=>{
 const b=new ClarifyBudget(config,()=>{},{...empty(),outputTokens:19900});b.beginTask("case");
 const transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{expect(JSON.parse(String(init?.body)).max_output_tokens).toBe(100);return json(result());});
 await send(b,transport);await expect(send(b,transport)).rejects.toThrow("OUTPUT_TOKEN_BUDGET");expect(transport).toHaveBeenCalledTimes(1);
});
it("formal SDK sends DeepSeek Responses schema and high effort, without retrying a transient failure",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");
 const transport=vi.fn(async(url:unknown,init?:RequestInit)=>{
  expect(url).toBe("https://api.deepseek.com/responses");expect(JSON.parse(String(init?.body))).toMatchObject({model:"deepseek-flash",reasoning:{effort:"high"},text:{format:{type:"json_schema"}}});
  return json({error:{type:"server_error",message:"offline",code:"server_error",param:null}},503);
 });const runner=createModelClarificationRunner({...config,apiKey:"offline",fetch:b.fetch(transport),maxOutputTokens:2000});
 await expect(evaluateClarification(taskForCase(clarifyCases[0]!),runner)).rejects.toThrow();expect(transport).toHaveBeenCalledTimes(1);
});
it("formal SDK completes a source-tool roundtrip with full history and sanitized local records",async()=>{
 const events:Record<string,unknown>[]=[];const b=new ClarifyBudget(config,e=>events.push(e));b.beginTask("case");
 const task=taskForCase(clarifyCases[0]!);const chunk=task.sources[0]!.chunks[0]!;let step=0;
 const transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));expect(body.reasoning).toEqual({effort:"high"});step++;
  if(step===2){expect(body.input.some((item:{type:string})=>item.type==="function_call_output")).toBe(true);expect(JSON.stringify(body.input)).toContain(chunk.text);}
  return json({...result(),id:`response-${step}`,created_at:1,system_fingerprint:"offline-fingerprint",output:step===1?
   [{type:"function_call",id:"fc-1",call_id:"call-1",name:"read_chunk",arguments:JSON.stringify({chunkId:chunk.id})}]:
   [{type:"message",id:"msg",role:"assistant",content:[{type:"output_text",text:JSON.stringify({draftVersion:1,basisRefs:["b"],bases:[{id:"b",origin:"agent",nature:"interpretation",statement:"No change in protocol test.",scope:"Offline"}],changes:[],corrections:[],question:null}),annotations:[]}]}]});
 });
 const runner=createModelClarificationRunner({...config,apiKey:"offline",fetch:b.fetch(transport),maxOutputTokens:2000});
 const outcome=await evaluateClarification(task,runner);expect(outcome.result.operations).toEqual([]);expect(transport).toHaveBeenCalledTimes(2);
 expect(b.state).toMatchObject({inputTokens:1000,outputTokens:200,microUsd:540});
 expect(events.filter(e=>e.type==="model_response").every(e=>(e.response as {system_fingerprint:string}).system_fingerprint==="offline-fingerprint")).toBe(true);
});
it("formal SDK cannot evade the local tool cap through one parallel response",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("case");const task=taskForCase(clarifyCases[0]!);
 const transport=vi.fn(async()=>json({...result(),id:"response",created_at:1,output:Array.from({length:13},(_,i)=>({type:"function_call",id:`fc-${i}`,call_id:`call-${i}`,name:"read_chunk",arguments:JSON.stringify({chunkId:task.sources[0]!.chunks[0]!.id})}))}));
 const runner=createModelClarificationRunner({...config,apiKey:"offline",fetch:b.fetch(transport),maxOutputTokens:2000,onEvent:e=>{if(e.type==="runner_budget_exhausted")b.stop(String(e.code));}});
 await expect(evaluateClarification(task,runner)).rejects.toThrow("TOOL_CALL_BUDGET");expect(b.state.stopped).toBe("TOOL_CALL_BUDGET");expect(transport).toHaveBeenCalledTimes(1);
});
it("a failed local reservation write prevents even the first DeepSeek request",async()=>{
 const b=new ClarifyBudget(config,e=>{if(e.type==="model_reserved")throw new Error("offline disk full");});b.beginTask("case");const transport=vi.fn();
 await expect(send(b,transport)).rejects.toThrow("RECORDING_FAILED");expect(transport).not.toHaveBeenCalled();expect(b.state.microUsd).toBe(316973);
});
