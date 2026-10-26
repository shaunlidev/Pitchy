import { z } from "zod";
import { deepSeekOutputSchema } from "./clarification-deepseek-schema";
import { httpErrorDiagnostic } from "./clarification-diagnostics";

export const clarifyLimits = Object.freeze({ tasks: 10, httpRequests: 60, stepsPerTask: 6, inputTokens: 120_000, outputTokens: 20_000, microUsd: 3_000_000, outputPerRequest: 2_000 });
const priceFields = {
  inputUsdPerMillion: z.number().finite().nonnegative(), outputUsdPerMillion: z.number().finite().nonnegative(),
  countRequestMicroUsd: z.number().int().nonnegative(), pricingSource: z.url(), pricingCheckedAt: z.iso.datetime(),
};
const openAIConfig = z.object({
  ...priceFields, provider: z.literal("openai").optional(),
  model: z.string().regex(/-\d{4}-\d{2}-\d{2}$/, "Select a dated model snapshot, not an alias."),
  baseURL: z.url().refine(s => { const u=new URL(s);return u.protocol==="https:"&&!u.username&&!u.password&&!u.search&&!u.hash&&u.pathname==="/v1"; }, "Use an explicit HTTPS Responses /v1 endpoint."),
}).strict();
const deepSeekConfig = z.object({
  ...priceFields, provider: z.literal("deepseek"), model: z.literal("deepseek-flash"),
  baseURL: z.literal("https://api.deepseek.com"),
  observedVersion: z.literal("DeepSeek-V4.1-Flash-1017"),
  reasoningEffort: z.literal("high"), inputAccounting: z.literal("context-window-reservation"),
  contextWindowTokens: z.literal(1_048_576),
  // Peak, cache-miss ceilings. A new price/version requires a reviewed update.
  inputUsdPerMillion: z.number().finite().min(0.30), outputUsdPerMillion: z.number().finite().min(1.20),
  countRequestMicroUsd: z.literal(0), // No count endpoint is called, not a claim of free counting.
}).strict();
export const clarifyLiveConfigSchema = z.union([openAIConfig, deepSeekConfig]);
export const deepSeekModelRequestLimit = 30;
export type ClarifyLiveConfig = z.infer<typeof clarifyLiveConfigSchema>;
export type BudgetState = { tasks: string[]; steps: Record<string,number>; httpRequests:number; modelRequests:number; inputTokens:number; outputTokens:number; microUsd:number; stopped?:string };
export class ClarifyStop extends Error { constructor(readonly code:string){super(code);this.name="ClarifyStop";} }
export type Journal = (event:Record<string,unknown>)=>void;
const whole=(n:unknown):n is number=>Number.isSafeInteger(n)&&Number(n)>=0;

export class ClarifyBudget {
  readonly state:BudgetState;
  private activeTask?:string;
  private busy=false;
  constructor(readonly config:ClarifyLiveConfig,readonly journal:Journal,initial?:BudgetState,readonly limits=clarifyLimits){
    clarifyLiveConfigSchema.parse(config);
    this.state=initial?structuredClone(initial):{tasks:[],steps:{},httpRequests:0,modelRequests:0,inputTokens:0,outputTokens:0,microUsd:0};
    if(!Array.isArray(this.state.tasks)||new Set(this.state.tasks).size!==this.state.tasks.length||!this.state.tasks.every(t=>typeof t==="string")||!this.state.steps||![this.state.httpRequests,this.state.modelRequests,this.state.inputTokens,this.state.outputTokens,this.state.microUsd,...Object.values(this.state.steps)].every(whole))throw new ClarifyStop("INVALID_LEDGER");
    if(this.state.modelRequests>this.state.httpRequests||Object.keys(this.state.steps).some(id=>!this.state.tasks.includes(id))||this.state.tasks.some(id=>!whole(this.state.steps[id])||this.state.steps[id]!>limits.stepsPerTask)||Object.values(this.state.steps).reduce((sum,n)=>sum+n,0)!==this.state.modelRequests)throw new ClarifyStop("INVALID_LEDGER");
    const maxInput = config.provider==="deepseek" ? limits.inputTokens+config.contextWindowTokens : limits.inputTokens;
    if(config.provider==="deepseek"&&this.state.modelRequests>deepSeekModelRequestLimit)throw new ClarifyStop("INVALID_LEDGER");
    if(this.state.tasks.length>limits.tasks||this.state.httpRequests>limits.httpRequests||this.state.inputTokens>maxInput||this.state.outputTokens>limits.outputTokens||this.state.microUsd>limits.microUsd)throw new ClarifyStop("INVALID_LEDGER");
  }
  private save(type:string,detail:Record<string,unknown>={}){
    try{this.journal({type,taskId:this.activeTask,...detail,budget:structuredClone(this.state)});}
    catch{this.state.stopped="RECORDING_FAILED";throw new ClarifyStop("RECORDING_FAILED");}
  }
  stop(code:string):never{this.state.stopped=code;this.save("stopped",{code});throw new ClarifyStop(code);}
  beginTask(id:string){
    if(this.busy)this.stop("CONCURRENT_REQUEST_FORBIDDEN");
    if(this.state.stopped)throw new ClarifyStop(this.state.stopped);
    if(this.state.tasks.includes(id))this.stop("TASK_ALREADY_ATTEMPTED");
    if(this.state.tasks.length>=this.limits.tasks)this.stop("TASK_BUDGET");
    this.state.tasks.push(id);this.state.steps[id]=0;this.activeTask=id;this.save("task_reserved");
  }
  fetch(transport:typeof fetch):typeof fetch {
    return async (url,init)=>{
      if(this.state.stopped)throw new ClarifyStop(this.state.stopped);
      if(this.busy)this.stop("CONCURRENT_REQUEST_FORBIDDEN");
      if(!this.activeTask)this.stop("NO_TASK_RESERVATION");
      if(String(url)!==`${this.config.baseURL}/responses`||init?.method!=="POST"||typeof init.body!=="string")this.stop("UNEXPECTED_ENDPOINT");
      this.busy=true;
      try{return await this.dispatch(transport,init!);}finally{this.busy=false;}
    };
  }
  private async dispatch(transport:typeof fetch,init:RequestInit):Promise<Response>{
    const taskId=this.activeTask!;
    if(this.state.steps[taskId]!>=this.limits.stepsPerTask)this.stop("STEP_BUDGET");
    // DeepSeek uses one generation request, without an undocumented count endpoint.
    const deepSeek = this.config.provider==="deepseek";
    if(deepSeek&&this.state.modelRequests>=deepSeekModelRequestLimit)this.stop("MODEL_REQUEST_BUDGET");
    if(this.state.httpRequests+(deepSeek?1:2)>this.limits.httpRequests)this.stop("HTTP_BUDGET");
    if(this.state.inputTokens>=this.limits.inputTokens)this.stop("INPUT_TOKEN_BUDGET");
    const outputMax=Math.min(this.limits.outputPerRequest,this.limits.outputTokens-this.state.outputTokens);
    if(outputMax<16)this.stop("OUTPUT_TOKEN_BUDGET");
    let body:Record<string,unknown>;
    try{body=JSON.parse(String(init.body));}catch{return this.stop("INVALID_REQUEST");}
    if(body.model!==this.config.model||body.stream===true||body.previous_response_id||body.conversation||body.background)this.stop("UNSUPPORTED_REQUEST");
    if(!Array.isArray(body.tools)||body.tools.some((tool:unknown)=>{const t=tool as Record<string,unknown>;return t.type!=="function"||!["read_chunk","search_chunks"].includes(String(t.name));}))this.stop("UNSUPPORTED_TOOLS");
    body.max_output_tokens=outputMax;body.store=false;
    let input:number;
    if(this.config.provider==="deepseek"){
      // This is a whole-context cost reservation, not an exact input-token estimate.
      input=this.config.contextWindowTokens;
      body.reasoning={effort:this.config.reasoningEffort};
      const text=body.text as {format?:{type?:string;schema?:unknown}}|undefined;
      if(text?.format?.type==="json_schema"){
        try{body.text={...text,format:{...text.format,schema:deepSeekOutputSchema(text.format.schema)}};}
        catch{return this.stop("UNSUPPORTED_OUTPUT_SCHEMA");}
      }
    }else{
      const count:Record<string,unknown>={};
      for(const key of ["model","input","instructions","tools","tool_choice","parallel_tool_calls","text","reasoning","truncation"])if(body[key]!==undefined)count[key]=body[key];
      if(this.state.microUsd>=this.limits.microUsd)this.stop("COST_BUDGET");
      const fee=this.config.countRequestMicroUsd;
      if(this.state.microUsd+fee>this.limits.microUsd)this.stop("COST_BUDGET");
      this.state.httpRequests++;this.state.microUsd+=fee;this.save("count_reserved",{request:count});
      let countBody:Record<string,unknown>;
      try{const response=await transport(`${this.config.baseURL}/responses/input_tokens`,{...init,body:JSON.stringify(count),redirect:"error"});if(!response.ok){this.save("http_error",{diagnostic:await httpErrorDiagnostic(response,init,"token_count")});this.stop("TOKEN_COUNT_HTTP_ERROR");}countBody=JSON.parse(await boundedText(response));}
      catch(error){if(error instanceof ClarifyStop)throw error;return this.stop("TOKEN_COUNT_FAILED");}
      if(countBody.object!=="response.input_tokens"||!whole(countBody.input_tokens))this.stop("INVALID_TOKEN_COUNT");
      if(this.state.stopped)throw new ClarifyStop(this.state.stopped);
      input=countBody.input_tokens;this.save("count_result",{inputTokens:input});
      if(this.state.inputTokens+input>this.limits.inputTokens)this.stop("INPUT_TOKEN_BUDGET");
    }
    const reserve=Math.ceil(input*this.config.inputUsdPerMillion+outputMax*this.config.outputUsdPerMillion);
    if(this.state.microUsd+reserve>this.limits.microUsd)this.stop("COST_BUDGET");
    this.state.httpRequests++;this.state.modelRequests++;this.state.steps[taskId]++;
    this.state.inputTokens+=input;this.state.outputTokens+=outputMax;this.state.microUsd+=reserve;
    // Durable reservation precedes dispatch. Unknown/failed usage never refunds it.
    this.save("model_reserved",{request:body,reserved:{inputTokens:input,outputTokens:outputMax,microUsd:reserve},inputAccounting:deepSeek?"context-window-reservation":"exact-provider-count",observedVersion:this.config.provider==="deepseek"?this.config.observedVersion:undefined});
    let response:Response,text:string,payload:Record<string,unknown>;
    const start=Date.now();
    try{response=await transport(`${this.config.baseURL}/responses`,{...init,body:JSON.stringify(body),redirect:"error"});}
    catch{return this.stop("MODEL_TRANSPORT_FAILED");}
    if(!response.ok){
      this.save("http_error",{elapsedMs:Date.now()-start,diagnostic:await httpErrorDiagnostic(response,init,"generation")});
      this.stop("MODEL_HTTP_ERROR");
    }
    try{text=await boundedText(response);payload=JSON.parse(text);}
    catch{return this.stop("MODEL_TRANSPORT_FAILED");}
    if(this.state.stopped)throw new ClarifyStop(this.state.stopped);
    const usage=payload.usage as Record<string,unknown>|undefined;
    // Explicit whitelist: never record headers, credentials or model reasoning items.
    const output=Array.isArray(payload.output)?payload.output.flatMap<Record<string,unknown>>((item:unknown)=>{
      const row=item as Record<string,unknown>;
      if(row.type==="function_call")return [{type:row.type,id:row.id,call_id:row.call_id,name:row.name,arguments:row.arguments}];
      if(row.type==="message")return [{type:row.type,id:row.id,role:row.role,content:Array.isArray(row.content)?row.content.filter((c:Record<string,unknown>)=>["output_text","refusal"].includes(String(c.type))):[]}];
      return [];
    }):[];
    this.save("model_response",{elapsedMs:Date.now()-start,httpStatus:response.status,response:{id:payload.id,model:payload.model,status:payload.status,system_fingerprint:payload.system_fingerprint,incomplete_details:payload.status === "incomplete" ? {reason:["max_output_tokens","content_filter"].includes(String((payload.incomplete_details as {reason?:unknown})?.reason)) ? (payload.incomplete_details as {reason:string}).reason : "unspecified"} : undefined,usage,output}});
    if(!response.ok)this.stop("MODEL_HTTP_ERROR");
    if(!usage||!whole(usage.input_tokens)||!whole(usage.output_tokens))this.stop("MISSING_USAGE");
    if(usage.input_tokens>input||usage.output_tokens>outputMax||payload.model!==this.config.model)this.stop("PROVIDER_BOUND_MISMATCH");
    const actual=Math.ceil(usage.input_tokens*this.config.inputUsdPerMillion+usage.output_tokens*this.config.outputUsdPerMillion);
    this.state.inputTokens-=input-usage.input_tokens;this.state.outputTokens-=outputMax-usage.output_tokens;this.state.microUsd-=reserve-actual;
    this.save("usage_settled",{usage,costUpperMicroUsd:actual});
    // completed is not proof of valid JSON. Explicit provider failures must not
    // be misclassified as syntax failures, and known usage still settles first.
    const refusal = output.some(item => Array.isArray(item.content) && item.content.some((c:Record<string,unknown>) => c.type === "refusal"));
    const protocolCode = payload.status === "incomplete" ? "PROVIDER_INCOMPLETE" : payload.status === "failed" ? "PROVIDER_FAILED" : refusal ? "PROVIDER_REFUSAL" : undefined;
    if (protocolCode) {
      this.save("provider_output_failed",{diagnostic:{stage:"provider",code:protocolCode,providerStatus:payload.status === "failed" ? "failed" : payload.status === "incomplete" ? "incomplete" : "completed"}});
      this.stop(protocolCode);
    }
    // Without exact pre-counting, input is a post-response stopping threshold.
    if(deepSeek&&this.state.inputTokens>=this.limits.inputTokens)this.stop("INPUT_TOKEN_BUDGET");
    return new Response(text,{status:response.status,headers:{"content-type":"application/json"}});
  }
}
async function boundedText(response:Response):Promise<string>{
 const reader=response.body?.getReader();if(!reader)throw new Error("Missing response body");const chunks:Uint8Array[]=[];let bytes=0;
 try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1_000_000)throw new Error("Response too large");chunks.push(value);}}finally{await reader.cancel();}
 return Buffer.concat(chunks).toString("utf8");
}
