import { appendFileSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ClarifyStop, type BudgetState } from "./clarification-budget";
export const appRoot=fileURLToPath(new URL("../../../",import.meta.url));
export const evidenceRoot=resolve(appRoot,".artifacts/clarify-live");
export const hash=(data:unknown)=>createHash("sha256").update(typeof data==="string"?data:JSON.stringify(data)).digest("hex");
export function codeFingerprint(){
 const paths=["packages/agent/src/clarification-draft.ts","packages/domain/src/clarification-v4.ts","packages/agent/src/clarification-failure.ts","packages/domain/src/clarification-grounding.ts","packages/evals/src/clarification-deepseek-schema.ts","packages/evals/src/clarification-diagnostics.ts","packages/evals/config/clarify-deepseek.json","packages/agent/src/clarification-runner.ts","packages/agent/src/tools.ts","packages/agent/src/prompt-safety.ts","packages/domain/src/clarification.ts","packages/domain/src/understanding.ts","packages/evals/src/clarification-cases.ts","packages/evals/src/clarification-offline.ts","packages/evals/src/clarification-budget.ts","packages/evals/src/clarification-live.ts","packages/evals/src/clarification-live-cli.ts","packages/evals/src/clarification-records.ts","packages/agent/package.json","pnpm-lock.yaml"];
 return Object.fromEntries(paths.map(path=>[path,hash(readFileSync(resolve(appRoot,path),"utf8"))]));
}
// Metadata-only accounting; do not open historical project content or databases.
export function availableEvidenceBytes(){
 const repo=dirname(appRoot),pkg=resolve(repo,"pitchroom-v6");
 const manifest=JSON.parse(readFileSync(resolve(pkg,"manifest.json"),"utf8"));
 const policy=manifest.evidencePolicy;
 const roots=[...policy.accountingPackageRoots.map((p:string)=>resolve(pkg,p)),...policy.accountingWorkspaceRoots.filter((r:{path:string;required:boolean})=>r.required||existsSync(resolve(repo,r.path))).map((r:{path:string})=>resolve(repo,r.path)),resolve(appRoot,".artifacts")];
 const unique=[...new Set<string>(roots)].filter((p,_,all)=>!all.some(other=>p!==other&&p.startsWith(other+"/")));
 return policy.approvedCapBytes-unique.reduce((total,p)=>total+(existsSync(p)?treeBytes(p):(()=>{throw new ClarifyStop("MISSING_EVIDENCE_ROOT");})()),0);
}
function treeBytes(path:string):number{const st=lstatSync(path);if(st.isSymbolicLink())throw new ClarifyStop("EVIDENCE_SYMLINK");return st.isDirectory()?readdirSync(path).reduce((n,p)=>n+treeBytes(join(path,p)),0):st.size;}

export class LocalClarifyRecords {
 private bytes:number;private previous="";private sequence=0;private lock:number;
 constructor(readonly root:string,readonly maxBytes:number,private readonly secrets:string[]=[]){
   this.lock=openSync(join(root,".lock"),"wx",0o600);
   this.bytes=treeBytes(root);
   try{
    const log=join(root,"events.jsonl");
    if(existsSync(log))for(const line of readFileSync(log,"utf8").split("\n").filter(Boolean)){
     const {digest,...entry}=JSON.parse(line);if(entry.previous!==this.previous||entry.sequence!==this.sequence+1||hash(entry)!==digest)throw new ClarifyStop("INVALID_JOURNAL");this.previous=digest;this.sequence=entry.sequence;
    }
   }catch(error){this.close();throw error;}
 }
 private encode(value:unknown){
   let data=JSON.stringify(value, (key,item)=>{
     if(/^(authorization|apiKey|api_key|encrypted_content|reasoning_content|chain_of_thought)$/i.test(key))return "[REDACTED]";
     if(item&&typeof item==="object"&&item.type==="reasoning")return {type:"reasoning",omitted:true};
     return item;
   });
   for(const secret of this.secrets)if(secret)data=data.replaceAll(secret,"[REDACTED]");return data;
 }
 write(name:string,value:unknown,exclusive=false){
   if(!/^[a-zA-Z0-9_.-]+\.json$/.test(name))throw new ClarifyStop("INVALID_RECORD_NAME");
   const path=join(this.root,name),text=this.encode(value)+"\n",old=existsSync(path)?statSync(path).size:0;
   if(exclusive&&old)throw new ClarifyStop("RECORD_EXISTS");
   if(this.bytes-old+Buffer.byteLength(text)>this.maxBytes-8192)throw new ClarifyStop("ARTIFACT_BUDGET");
   const tmp=path+`.${randomUUID()}.tmp`;writeFileSync(tmp,text,{flag:"wx",mode:0o600});renameSync(tmp,path);this.bytes+=Buffer.byteLength(text)-old;
 }
 read<T>(name:string):T{if(!/^[a-zA-Z0-9_.-]+\.json$/.test(name))throw new ClarifyStop("INVALID_RECORD_NAME");return JSON.parse(readFileSync(join(this.root,name),"utf8"));}
 event=(value:Record<string,unknown>)=>{
   const entry=JSON.parse(this.encode({sequence:this.sequence+1,previous:this.previous,at:new Date().toISOString(),...value}));const digest=hash(entry),line=JSON.stringify({...entry,digest})+"\n";
   if(this.bytes+Buffer.byteLength(line)>this.maxBytes-8192)throw new ClarifyStop("ARTIFACT_BUDGET");
   appendFileSync(join(this.root,"events.jsonl"),line,{mode:0o600});this.bytes+=Buffer.byteLength(line);this.previous=digest;this.sequence++;
 };
 firstEvent():Record<string,unknown>{return JSON.parse(readFileSync(join(this.root,"events.jsonl"),"utf8").split("\n")[0]!);}
 httpDiagnostics(){
   const path=join(this.root,"events.jsonl");if(!existsSync(path))return [];
   return readFileSync(path,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)).filter(e=>e.type==="http_error").map(e=>({sequence:e.sequence,taskId:e.taskId,elapsedMs:e.elapsedMs,diagnostic:e.diagnostic}));
 }
 executionDiagnostics(){
   const path=join(this.root,"events.jsonl");if(!existsSync(path))return [];
   return readFileSync(path,"utf8").split("\n").filter(Boolean).map(line=>JSON.parse(line)).flatMap<Record<string,unknown>>(e=>e.type==="clarification_failed"||e.type==="provider_output_failed" ? [{sequence:e.sequence,diagnostic:e.diagnostic}] : e.type==="model_response" ? [{sequence:e.sequence,httpStatus:e.httpStatus,providerStatus:e.response?.status,incompleteDetails:e.response?.incomplete_details}] : []);
 }
 lastBudget():BudgetState|undefined{
   const path=join(this.root,"events.jsonl");if(!existsSync(path))return undefined;
   const events=readFileSync(path,"utf8").trim().split("\n").map(line=>JSON.parse(line));return events.filter(e=>e.budget).at(-1)?.budget;
 }
 abort(code:string){
   const path=join(this.root,"termination.json"),text=this.encode({code,at:new Date().toISOString(),budget:this.lastBudget()})+"\n";
   if(this.bytes+Buffer.byteLength(text)<=this.maxBytes&&!existsSync(path)){writeFileSync(path,text,{flag:"wx",mode:0o600});this.bytes+=Buffer.byteLength(text);}
 }
 close(){closeSync(this.lock);rmSync(join(this.root,".lock"));}
}
export function createSessionDirectory(parent=evidenceRoot){
 mkdirSync(parent,{recursive:true,mode:0o700});const root=join(parent,`clarify-${new Date().toISOString().replace(/[:.]/g,"-")}-${randomUUID()}`);mkdirSync(root,{mode:0o700});return root;
}
export function checkedSessionPath(path:string,parent=evidenceRoot){const root=realpathSync(path);if(dirname(root)!==realpathSync(parent)||lstatSync(path).isSymbolicLink())throw new ClarifyStop("INVALID_SESSION_PATH");return root;}
