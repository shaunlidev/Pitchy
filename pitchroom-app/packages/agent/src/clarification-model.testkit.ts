// Offline provider substitute: exercises the real AI SDK agent loop, no network.
import { MockLanguageModelV4 } from "ai/test";
export const mockUsage = { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } };
export function scriptedClarificationModel(output: unknown, chunkId?: string) {
  const text = { content: [{ type: "text" as const, text: JSON.stringify(output) }], finishReason: { unified: "stop" as const, raw: "stop" }, usage: mockUsage, warnings: [] };
  return new MockLanguageModelV4({ doGenerate: chunkId ? [
    { content: [{ type: "tool-call", toolCallId: "read-1", toolName: "read_chunk", input: JSON.stringify({chunkId}) }], finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage: mockUsage, warnings: [] }, text,
  ] : text });
}

import type { ClarificationResult, UnderstandingProposalV1 } from "@pitchroom/domain";
// Explicit fixture upgrade for protocol/mechanism tests only. This is not a semantic runner.
export function groundedTestResult(result: ClarificationResult, base: UnderstandingProposalV1): Extract<ClarificationResult, {schemaVersion: 3}> {
  if (result.schemaVersion === 3) return result;
  if (result.schemaVersion === 4) throw new Error("Use groundedV4TestResult for v4 fixtures");
  const basis = [{kind:"agent_inference" as const, force:"interpretation" as const, statement:"Offline scripted assessment; not a model judgment.", scope:"Synthetic protocol fixture only"}];
  return {schemaVersion:3, reason:result.reason, reasonBasis:basis, operations:result.operations.map(op => {
    if(op.type === "update_summary") return {...op, basis, applicability:(base.themes.find(t=>t.id===op.themeId)?.claims ?? []).filter(c=>c.evidence.length).map(c=>({claimId:c.id!,status:"unconfirmed" as const,currentInterpretation:"Current applicability remains unconfirmed.",explanation:"Retain the historical material record.",basis}))};
    if(op.type === "next_question" && "relatedThemeIds" in op) return {...op, grounding:{objective:"Resolve the stated unknown",primaryThemeId:op.relatedThemeIds[0]!,associations:op.relatedThemeIds.map(themeId=>({themeId,unresolvedIssue:"The question's stated unknown",rationale:"The scripted question addresses this unknown."})),basis}};
    return op;
  })} as Extract<ClarificationResult, {schemaVersion: 3}>;
}

// Explicit v4 wire fixture adaptation. Never imported by a production runner.
export function groundedV4TestResult(result: ClarificationResult, base: UnderstandingProposalV1): Extract<ClarificationResult, {schemaVersion: 4}> {
  if (result.schemaVersion === 4) return result;
  const old = result.schemaVersion === 3 ? result : groundedTestResult(result, base);
  const bases: Extract<ClarificationResult, {schemaVersion: 4}>["bases"] = [];
  const ids = new Map<string,string>();
  const ref = (basis: Extract<ClarificationResult,{schemaVersion:3}>["reasonBasis"][number]) => {
    const key = JSON.stringify(basis);const found = ids.get(key);if(found)return found;
    const id = `basis-${bases.length+1}`;ids.set(key,id);
    const nature = basis.force === "report" ? "record" as const : basis.force;
    const common = {id,nature,statement:basis.statement,scope:basis.scope,requirement:basis.force === "requirement" && basis.kind === "material" ? {issuer:"Material author",action:basis.statement,condition:basis.scope,supportingQuote:basis.evidence[0]!.quote} : null};
    bases.push(basis.kind === "material" ? {...common,origin:"material",evidence:basis.evidence} : basis.kind === "user_report" ? {...common,origin:"user",inputIds:basis.inputIds} : {...common,origin:"agent"});
    return id;
  };
  const reasonBasisRefs = old.reasonBasis.map(ref);
  const operations = old.operations.map(op => {
    if (op.type === "update_summary") { const {basis,applicability,...rest}=op;return {...rest,basisRefs:basis.map(ref),applicability:applicability.map(a=>{const {basis,...rest}=a;return {...rest,basisRefs:basis.map(ref)};})}; }
    if (op.type === "next_question") { const {grounding,...rest}=op;if(!grounding)return rest as Extract<ClarificationResult,{schemaVersion:4}>["operations"][number];return {...rest,groundingV4:{objective:grounding.objective,primaryThemeId:grounding.primaryThemeId,associations:grounding.associations.map(a=>({...a,questionSpan:op.question,expectedAnswer:a.unresolvedIssue})),basisRefs:grounding.basis.map(ref)}}; }
    return op;
  });
  return {schemaVersion:4,reason:old.reason,bases,reasonBasisRefs,operations};
}

export function rawClarificationModel(text: string) {
  return new MockLanguageModelV4({ doGenerate: { content: [{ type: "text", text }], finishReason: { unified: "stop", raw: "stop" }, usage: mockUsage, warnings: [] } });
}

import { ModelClarificationRunner } from "./clarification-runner";
export function legacyResultRunner(model: ConstructorParameters<typeof ModelClarificationRunner>[0], timeout=60000, options: ConstructorParameters<typeof ModelClarificationRunner>[2]={}) {
 return new ModelClarificationRunner(model,timeout,{...options,wireFormat:"result-v4"});
}
export function draftTestResultFromV4(result:Extract<ClarificationResult,{schemaVersion:4}>,base?:UnderstandingProposalV1) {
 const bases:any[]=result.bases.map(b=>{const {requirement,...base}=b;const rest=base.origin==="user"?((({inputIds,...current})=>current)(base)):base;return requirement?{...rest,requirement}:rest;});
 const changes=result.operations.filter(op=>op.type==="update_summary").map((op,i)=>{
  const id=`offline-summary-${i}`;bases.push({id,origin:"agent",nature:"interpretation",statement:op.text,scope:"Offline fixture current understanding"});
  return {themeId:op.themeId,basisRefs:[...op.basisRefs.filter(id=>result.bases.find(b=>b.id===id)?.origin!=="agent"),id],materialApplicability:op.applicability,evidenceJudgments:base?.themes.find(t=>t.id===op.themeId)?.claims.some(c=>c.evidenceState==="conflicting")?[{claim:op.text,verdict:"unconfirmed",explanation:"Offline protocol fixture only; quality is not assessed."}]:[]};
 });
 return {draftVersion:1,bases,basisRefs:result.reasonBasisRefs,changes,corrections:result.operations.filter(op=>op.type==="supersede_user_assertion").map(op=>op.claimId),question:(()=>{const q=result.operations.find(op=>op.type==="next_question");return q?{basisRefs:q.groundingV4.basisRefs,clauses:q.groundingV4.associations.map(a=>({kind:"open",themeId:a.themeId,ask:a.questionSpan,unresolvedIssue:a.unresolvedIssue,expectedAnswer:a.expectedAnswer}))}:null;})()};
}
