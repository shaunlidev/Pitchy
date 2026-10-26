import { expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { createModelClarificationRunner, evaluateClarification } from "@pitchroom/agent";
import { clarificationResultV4Schema } from "@pitchroom/domain";
import { z } from "zod";
import { ClarifyBudget, clarifyLiveConfigSchema, ClarifyStop } from "./clarification-budget";
import { deepSeekOutputSchema } from "./clarification-deepseek-schema";
import { clarifyCases, taskForCase } from "./clarification-cases";
const config=clarifyLiveConfigSchema.parse(JSON.parse(readFileSync(new URL("../config/clarify-deepseek.json",import.meta.url),"utf8")));
const json=(payload:unknown)=>new Response(JSON.stringify(payload),{status:200,headers:{"content-type":"application/json"}});

it("v4 wire schema includes independent nature, nullable requirement and shared references without mutating local strict schema",()=>{
 const schema=z.toJSONSchema(clarificationResultV4Schema,{target:"draft-7"}),before=structuredClone(schema),converted=deepSeekOutputSchema(schema) as any;
 expect(schema).toEqual(before);expect(JSON.stringify(converted)).not.toContain('"oneOf"');
 const branches=converted.properties.bases.items.anyOf;
 for(const b of branches){expect(b.properties.nature.enum).toContain("suggestion");expect(b.required).toContain("requirement");expect(b.additionalProperties).toBe(false);}
 expect(converted.properties.reasonBasisRefs.minItems).toBe(1);
 const question=converted.properties.operations.items.anyOf.find((o:any)=>o.properties.type.const==="next_question");
 expect(question.properties.groundingV4.properties.associations.items.required).toContain("questionSpan");expect(question.properties.groundingV4.properties.associations.items.required).toContain("expectedAnswer");
});
it("HTTP 200 completed with malformed JSON is syntax failure, not successful compatibility or a repair opportunity",async()=>{
 const events:Record<string,unknown>[]=[],b=new ClarifyBudget(config,e=>events.push(e));b.beginTask("single");
 const transport=vi.fn(async(_url:unknown,init?:RequestInit)=>{
  const request=JSON.parse(String(init?.body));expect(request.text.format).toMatchObject({type:"json_schema",strict:true});expect(request.max_output_tokens).toBe(2000);
  return json({id:"offline",created_at:1,model:config.model,status:"completed",usage:{input_tokens:1200,output_tokens:600},output:[{id:"msg",type:"message",role:"assistant",content:[{type:"output_text",text:'{"reason":"Premature close"},"operations":[]}',annotations:[]}]}]});
 });
 const t=taskForCase(clarifyCases[0]!),snapshot=structuredClone(t);
 await expect(evaluateClarification(t,createModelClarificationRunner({...config,apiKey:"offline-secret",fetch:b.fetch(transport),onEvent:e=>events.push(e)}))).rejects.toMatchObject({diagnostic:{stage:"syntax",code:"INVALID_JSON"}});
 expect(transport).toHaveBeenCalledTimes(1);expect(t).toEqual(snapshot);expect(events).toContainEqual(expect.objectContaining({type:"usage_settled"}));expect(events).toContainEqual(expect.objectContaining({type:"clarification_failed",diagnostic:expect.objectContaining({stage:"syntax"})}));
 expect(b.state.microUsd).toBe(1080);expect(events.filter(e=>e.type==="model_response")[0]).toMatchObject({httpStatus:200,response:{status:"completed"}});
});
it.each(["incomplete","failed","refusal"] as const)("classifies provider %s before JSON syntax and settles known usage without retry",async mode=>{
 const events:Record<string,unknown>[]=[],b=new ClarifyBudget(config,e=>events.push(e));b.beginTask("single");
 const transport=vi.fn(async()=>json({id:"offline",model:config.model,status:mode==="refusal"?"completed":mode,incomplete_details:mode==="incomplete"?{reason:"max_output_tokens",thinking:"must not be saved"}:undefined,usage:{input_tokens:1000,output_tokens:500},output:[{id:"msg",type:"message",role:"assistant",content:mode==="refusal"?[{type:"refusal",refusal:"Cannot produce the requested output"}]:[{type:"output_text",text:'{"unfinished":',annotations:[]}]}]}));
 const code=mode==="incomplete"?"PROVIDER_INCOMPLETE":mode==="failed"?"PROVIDER_FAILED":"PROVIDER_REFUSAL";
 await expect(evaluateClarification(taskForCase(clarifyCases[0]!),createModelClarificationRunner({...config,apiKey:"offline-secret",fetch:b.fetch(transport),onEvent:e=>events.push(e)}))).rejects.toBeInstanceOf(ClarifyStop);
 expect(b.state.stopped).toBe(code);expect(transport).toHaveBeenCalledTimes(1);expect(b.state.microUsd).toBe(900);expect(events).toContainEqual(expect.objectContaining({type:"clarification_failed",diagnostic:expect.objectContaining({stage:"provider",code})}));expect(JSON.stringify(events)).not.toContain("must not be saved");
});
