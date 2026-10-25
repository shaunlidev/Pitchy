import { draftTestResultFromV4 } from "../../agent/src/clarification-model.testkit";
import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { clarificationResultV4Schema } from "@pitchroom/domain";
import { createModelClarificationRunner, evaluateClarification } from "@pitchroom/agent";
import { deepSeekOutputSchema } from "./clarification-deepseek-schema";
import { ClarifyBudget, clarifyLiveConfigSchema } from "./clarification-budget";
import { clarifyCases, taskForCase } from "./clarification-cases";
const config=clarifyLiveConfigSchema.parse(JSON.parse(readFileSync(new URL("../config/clarify-deepseek.json",import.meta.url),"utf8")));
const tag=(value:string)=>({type:"object",properties:{type:{type:"string",const:value}},required:["type"],additionalProperties:false});
const json=(body:unknown)=>new Response(JSON.stringify(body),{status:200,headers:{"content-type":"application/json"}});

it("converts the real discriminated operation schema without removing strict constraints or mutating the original",()=>{
 const original=z.toJSONSchema(clarificationResultV4Schema,{target:"draft-7"});const before=structuredClone(original);
 const converted=deepSeekOutputSchema(original);
 const expected=converted as any;
 const items=expected.properties.operations.items;
 expect(items.oneOf).toBeUndefined();expect(original).toEqual(before);
 expect(JSON.stringify(converted)).not.toContain('"oneOf"');
 expect(items.anyOf.find((s:any)=>s.properties.type.const==="update_summary").properties.basisRefs.minItems).toBe(1);
 expect(items.anyOf).toHaveLength(4);expect(new Set(items.anyOf.map((s:any)=>s.properties.type.const)).size).toBe(4);
 expect(expected.additionalProperties).toBe(false);expect(items.anyOf.every((s:any)=>s.additionalProperties===false)).toBe(true);
 expect(expected.properties.operations.maxItems).toBe(8);
});
it("walks nested schema positions while preserving property names and annotation data",()=>{
 const union={oneOf:[tag("a"),tag("b")]};
 const schema={type:"object",properties:{oneOf:{type:"string"},nested:{type:"array",items:union}},$defs:{choice:union},description:"oneOf is data here",examples:[{oneOf:[1,2]}],const:{oneOf:[1,2]}};
 const output=deepSeekOutputSchema(schema) as any;
 expect(output.properties.oneOf).toEqual({type:"string"});expect(output.properties.nested.items).toEqual({anyOf:[tag("a"),tag("b")]});expect(output.$defs.choice).toEqual({anyOf:[tag("a"),tag("b")]});expect(output.examples).toEqual(schema.examples);expect(output.const).toEqual(schema.const);
});
it.each([
 {oneOf:[{type:"string"},{type:"string",minLength:1}]},
 {oneOf:[tag("same"),tag("same")]},
 {oneOf:[tag("a"),{...tag("b"),required:[]}]},
 {oneOf:[tag("a"),{...tag("b"),type:"array"}]},
 {oneOf:[tag("a"),tag("b")],anyOf:[{type:"object"}]},
 {oneOf:[]},
])("refuses an unproven or overlapping oneOf instead of weakening it: %j",schema=>{
 expect(()=>deepSeekOutputSchema(schema)).toThrow("UNSUPPORTED_OUTPUT_SCHEMA");
});
it("unsupported output schemas stop before any HTTP request or cost reservation",async()=>{
 const b=new ClarifyBudget(config,()=>{});b.beginTask("test");const transport=vi.fn();
 await expect(b.fetch(transport)(`${config.baseURL}/responses`,{method:"POST",body:JSON.stringify({model:config.model,tools:[],text:{format:{type:"json_schema",schema:{oneOf:[{type:"string"},{type:"number"}]}}}})})).rejects.toThrow("UNSUPPORTED_OUTPUT_SCHEMA");
 expect(transport).not.toHaveBeenCalled();expect(b.state.microUsd).toBe(0);
});

const valid={schemaVersion:4,reason:"Offline protocol validation only.",reasonBasisRefs:["b"],bases:[{id:"b",origin:"agent",nature:"interpretation",requirement:null,statement:"Protocol fixture",scope:"Offline"}],operations:[]};
it.each([
 ["valid unchanged proposal",valid,true],
 ["unknown root field",{...valid,approved:true},false],
 ["unknown operation",{...valid,operations:[{type:"apply"}]},false],
 ["extra operation field",{...valid,operations:[{type:"add_answer",themeId:"T1",approved:true}]},false],
 ["missing operation field",{...valid,operations:[{type:"update_summary",themeId:"T1"}]},false],
 ["invalid theme association",{...valid,operations:[{type:"add_answer",themeId:"does-not-exist"}]},false],
 ["too many operations",{...valid,operations:Array.from({length:9},()=>({type:"add_answer",themeId:"T1"}))},false],
] as const)("formal DeepSeek runner receives anyOf wire schema and locally validates %s",async(_name,output,accept)=>{
 const task=taskForCase(clarifyCases[0]!);const snapshot=structuredClone(task);const b=new ClarifyBudget(config,()=>{});b.beginTask("test");
 const transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));const schema=body.text.format.schema;const items=schema.properties.changes.items;
  expect(items.oneOf).toBeUndefined();expect(items.anyOf).toHaveLength(4);expect(body.text.format.strict).toBe(true);expect(schema.additionalProperties).toBe(false);
  return json({id:"offline",created_at:1,model:config.model,status:"completed",usage:{input_tokens:500,output_tokens:100},output:[{id:"msg",type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(_name === "valid unchanged proposal" ? draftTestResultFromV4(output as any) : output),annotations:[]}]}]});
 });
 const runner=createModelClarificationRunner({...config,apiKey:"offline",fetch:b.fetch(transport),maxOutputTokens:2000});
 if(accept)expect((await evaluateClarification(task,runner)).result.operations).toEqual([]);
 else await expect(evaluateClarification(task,runner)).rejects.toThrow();
 expect(task).toEqual(snapshot);expect(transport).toHaveBeenCalledTimes(1);
});
it("leaves the OpenAI output schema unchanged in both counting and generation",async()=>{
 const cfg={model:"offline-2026-01-01",baseURL:"https://offline.invalid/v1",inputUsdPerMillion:1,outputUsdPerMillion:1,countRequestMicroUsd:0,pricingSource:"https://offline.invalid/pricing",pricingCheckedAt:"2026-10-25T00:00:00Z"};
 const schema={oneOf:[tag("a"),tag("b")]};const b=new ClarifyBudget(cfg,()=>{});b.beginTask("test");
 const transport=vi.fn(async(url:unknown,init?:RequestInit)=>{
  expect(JSON.parse(String(init?.body)).text.format.schema).toEqual(schema);
  return String(url).endsWith("input_tokens")?json({object:"response.input_tokens",input_tokens:100}):json({model:cfg.model,usage:{input_tokens:100,output_tokens:10},output:[]});
 });
 await b.fetch(transport)(`${cfg.baseURL}/responses`,{method:"POST",body:JSON.stringify({model:cfg.model,tools:[],text:{format:{type:"json_schema",schema}}})});expect(transport).toHaveBeenCalledTimes(2);
});
it("draft basis branches remain explicit typed objects with all properties required",async()=>{
 const {clarificationDraftSchema}=await import("../../agent/src/clarification-draft");
 const wire=deepSeekOutputSchema(z.toJSONSchema(clarificationDraftSchema(taskForCase(clarifyCases[0]!)),{target:"draft-7"})) as any;
 const visit=(node:any)=>{if(!node||typeof node!=="object")return;if(node.type==="object"){expect(new Set(node.required)).toEqual(new Set(Object.keys(node.properties??{})));expect(node.additionalProperties).toBe(false);}if(node.anyOf)for(const alternative of node.anyOf){expect(alternative.type).toBeDefined();}for(const value of Object.values(node))if(Array.isArray(value))value.forEach(visit);else visit(value);};
 visit(wire);const alternatives=wire.properties.bases.items.anyOf;expect(alternatives).toHaveLength(7);expect(alternatives.filter((b:any)=>b.properties.nature.const==="requirement")).toHaveLength(3);expect(alternatives.filter((b:any)=>!b.properties.requirement)).toHaveLength(4);
});

it("production worker factory adapts DeepSeek without an eval-budget wrapper", async()=>{
 const task=taskForCase(clarifyCases[0]!);const before=structuredClone(task);
 const transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const body=JSON.parse(String(init?.body));
  expect(body.max_output_tokens).toBe(8000);
  expect(JSON.stringify(body.text.format.schema)).not.toContain('"oneOf"');
  expect(body.text.format.strict).toBe(true);
  return json({id:"production-wire",created_at:1,model:config.model,status:"completed",usage:{input_tokens:500,output_tokens:100},output:[{id:"msg",type:"message",role:"assistant",content:[{type:"output_text",text:JSON.stringify(draftTestResultFromV4(valid as any)),annotations:[]}]}]});
 });
 const result=await evaluateClarification(task,createModelClarificationRunner({apiKey:"offline",model:config.model,baseURL:config.baseURL,fetch:transport}));
 expect(result.result.operations).toEqual([]);expect(task).toEqual(before);expect(transport).toHaveBeenCalledTimes(1);
});
