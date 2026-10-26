// Error bodies are untrusted provider data. Keep only bounded diagnostic fields;
// never persist raw HTML/text, arbitrary response objects, headers or reasoning.
const sensitiveKey = /^(authorization|proxy.authorization|api.?key|access.?token|refresh.?token|password|secret|reasoning|reasoning[_-]?content|encrypted[_-]?content|chain[_-]?of[_-]?thought|thinking)$/i;
const hiddenMarker = /reasoning[_\s-]*(?:content|text)|reasoning\s*:|thinking\s*:|chain[_\s-]*of[_\s-]*thought|encrypted[_\s-]*content|<think\b|"(?:thinking|reasoning)"\s*:/i;
const maxBodyBytes = 16_384;

function requestSecrets(init: RequestInit): string[] {
  const authorization = new Headers(init.headers).get("authorization");
  return authorization ? [authorization, authorization.replace(/^Bearer\s+/i, "")].filter(Boolean) : [];
}
function secretsInBody(payload: unknown): string[] {
  const secrets: string[]=[];
  const pending: Array<{value:unknown;blocked:boolean}>=[{value:payload,blocked:false}];
  while(pending.length){
    const {value,blocked}=pending.pop()!;
    if(typeof value==="string"){if(blocked&&value)secrets.push(value);continue;}
    if(!value||typeof value!=="object")continue;
    for(const [key,item] of Object.entries(value))pending.push({value:item,blocked:blocked||sensitiveKey.test(key)||["reasoning","thinking"].includes(String((value as {type?:unknown}).type))});
  }
  return secrets;
}
function safeField(value:unknown,secrets:string[]):string|undefined {
  if(typeof value!=="string"&&typeof value!=="number")return undefined;
  let text=String(value);
  // A message that embeds thoughts cannot be safely reduced by a guessed delimiter.
  if(hiddenMarker.test(text))return "[OMITTED: sensitive or hidden-content marker]";
  for(const secret of secrets.sort((a,b)=>b.length-a.length))text=text.split(secret).join("[REDACTED]");
  text=text.replace(/\bBearer\s+[^\s"'<>;,]+/gi,"Bearer [REDACTED]")
    .replace(/\bsk-[a-zA-Z0-9_-]+/g,"[REDACTED]")
    .replace(/\b(api[_-]?key|authorization|access[_-]?token|password|secret)\s*[:=]\s*[^\s"'<>;,]+/gi,"$1=[REDACTED]");
  return text.length>2000?text.slice(0,2000)+"[TRUNCATED]":text;
}
export type HttpErrorDiagnostic = {
  stage: "generation" | "token_count"; httpStatus: number;
  bodyPolicy: string; bodyLimitBytes: number; bodyBytes?: number;
  body?: {error: Record<string,string>}; bodyOmitted?: string;
};
export async function httpErrorDiagnostic(response:Response,init:RequestInit,stage:"generation"|"token_count"):Promise<HttpErrorDiagnostic> {
  const base={stage,httpStatus:response.status,bodyPolicy:"allowlisted-json-error-fields",bodyLimitBytes:maxBodyBytes};
  let text:string;
  try{
    const reader=response.body?.getReader();if(!reader)return {...base,bodyOmitted:"empty"};
    const chunks:Uint8Array[]=[];let bytes=0;
    try{for(;;){const {value,done}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>maxBodyBytes)return {...base,bodyOmitted:"oversized"};chunks.push(value);}}
    finally{await reader.cancel();}
    text=Buffer.concat(chunks).toString("utf8");
  }catch{return {...base,bodyOmitted:"read_failed"};}
  let payload:unknown;
  try{payload=JSON.parse(text);}catch{return {...base,bodyOmitted:"non_json",bodyBytes:Buffer.byteLength(text)};}
  if(!payload||typeof payload!=="object"||Array.isArray(payload))return {...base,bodyOmitted:"unrecognized_json"};
  const object=payload as Record<string,unknown>;
  const error=object.error;
  const source=error&&typeof error==="object"&&!Array.isArray(error)?error as Record<string,unknown>:object;
  const secrets=[...requestSecrets(init),...secretsInBody(payload)];
  const body=Object.fromEntries(["message","type","code","param"].flatMap(key=>{
    const value=safeField(source[key],secrets);return value===undefined?[]:[[key,value]];
  }));
  // Some providers return error as a plain string rather than an object.
  if(typeof error==="string")body.message=safeField(error,secrets)!;
  return {...base,bodyBytes:Buffer.byteLength(text),body:Object.keys(body).length?{error:body}:undefined,bodyOmitted:Object.keys(body).length?undefined:"no_allowed_error_fields"};
}
