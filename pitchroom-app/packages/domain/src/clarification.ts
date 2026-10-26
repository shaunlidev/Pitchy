import { z } from "zod";
import { basisTableV4Schema, applicabilityV4Schema, questionGroundingV4Schema, clarificationFailureSchema, ClarificationValidationError, type ClarificationBasisV4, type ClarificationFailureDiagnostic } from "./clarification-v4";
import { clarificationBasesSchema, applicabilitySchema, questionGroundingSchema, type ClarificationBasis } from "./clarification-grounding";
import { PitchroomError } from "./errors";
import { topicTasksFor, understandingProposalV1Schema, validateProposalEvidence, type UnderstandingProposalV1 } from "./understanding";
import type { SourceRecord } from "./source-repository";

export const topicTaskSelectionSchema = z.object({ understandingId: z.string().min(1), taskId: z.string().min(1), themeIndex: z.number().int().nonnegative() }).strict();
export type TopicTaskSelection = z.infer<typeof topicTaskSelectionSchema>;
export function sameTopicTaskSelection(left: TopicTaskSelection | undefined, right: TopicTaskSelection | undefined): boolean {
  return left?.understandingId === right?.understandingId && left?.taskId === right?.taskId && left?.themeIndex === right?.themeIndex;
}

const summaryOperation = z.object({ type: z.literal("update_summary"), themeId: z.string(), text: z.string().min(1).max(4000) }).strict();
const answerOperation = z.object({ type: z.literal("add_answer"), themeId: z.string() }).strict();
const questionFields = { type: z.literal("next_question"), question: z.string().min(1).max(1000), whyItMatters: z.string().min(1).max(1000) };
const reason = z.string().min(1).max(2000);
// Read old persisted results without inventing associations or correction history.
const legacyResultSchema = z.object({ schemaVersion: z.literal(1).optional(), reason, operations: z.array(z.discriminatedUnion("type", [summaryOperation, answerOperation, z.object(questionFields).strict()])).max(8) }).strict();
export const clarificationResultV2Schema = z.object({
  schemaVersion: z.literal(2), reason,
  operations: z.array(z.discriminatedUnion("type", [
    summaryOperation, answerOperation,
    z.object({ ...questionFields, relatedThemeIds: z.array(z.string().min(1)).min(1).max(5) }).strict(),
    z.object({ type: z.literal("supersede_user_assertion"), themeId: z.string(), claimId: z.string() }).strict(),
  ])).max(8),
}).strict();
export const clarificationResultV3Schema = z.object({
  schemaVersion: z.literal(3), reason, reasonBasis: clarificationBasesSchema,
  operations: z.array(z.discriminatedUnion("type", [
    summaryOperation.extend({ basis: clarificationBasesSchema, applicability: z.array(applicabilitySchema).max(12) }).strict(),
    answerOperation,
    z.object({ ...questionFields, relatedThemeIds: z.array(z.string().min(1)).min(1).max(5), grounding: questionGroundingSchema }).strict(),
    z.object({ type: z.literal("supersede_user_assertion"), themeId: z.string(), claimId: z.string() }).strict(),
  ])).max(8),
}).strict();
export const clarificationResultV4Schema = z.object({
  schemaVersion: z.literal(4), reason, bases: basisTableV4Schema, reasonBasisRefs: z.array(z.string().min(1)).min(1).max(12),
  operations: z.array(z.discriminatedUnion("type", [
    summaryOperation.extend({ basisRefs: z.array(z.string().min(1)).min(1).max(12), applicability: z.array(applicabilityV4Schema).max(12) }).strict(),
    answerOperation,
    z.object({ ...questionFields, relatedThemeIds: z.array(z.string().min(1)).min(1).max(5), groundingV4: questionGroundingV4Schema }).strict(),
    z.object({ type: z.literal("supersede_user_assertion"), themeId: z.string(), claimId: z.string() }).strict(),
  ])).max(8),
}).strict();
export const clarificationResultSchema = z.union([clarificationResultV4Schema, clarificationResultV3Schema, clarificationResultV2Schema, legacyResultSchema]);
const reassessmentSchema = z.object({
  rebasedFromTaskId: z.string(), originalUnderstandingId: z.string(),
  originalQuestion: understandingProposalV1Schema.shape.nextQuestion,
  sourceChanges: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.string()) }),
});
export type ReassessmentContext = z.infer<typeof reassessmentSchema>;
export type ClarificationResult = z.infer<typeof clarificationResultSchema>;
export type ClarificationTask = {
  id: string; createdAt: string; runMode: "synthetic" | "live"; projectId: string; inputId: string; commandId: string; actorId: string;
  baseUnderstandingId: string; baseRevision: number; basePhase?: "accepted" | "review_required"; sourceFingerprint: string;
  selection?: TopicTaskSelection;
  reassessment?: ReassessmentContext;
  answer: string; question: UnderstandingProposalV1["nextQuestion"];
  base: UnderstandingProposalV1; sources: SourceRecord[];
  status: "queued" | "running" | "proposal_ready" | "no_change" | "failed" | "stale" | "applied" | "dismissed";
  attempts: Array<{ id: string; commandId: string; status: "queued" | "running" | "completed" | "failed"; startedAt?: string; finishedAt?: string; model: string; promptVersion: string; error?: string; failure?: ClarificationFailureDiagnostic }>;
  result?: ClarificationResult; appliedResult?: ClarificationResult; candidate?: UnderstandingProposalV1;
  leaseUntil?: string; resultVersionId?: string; decisionCommandId?: string; decisionRequest?: string;
};
export const sourceFingerprint = (sources: SourceRecord[]) => JSON.stringify(sources.map(s => [s.id, s.contentHash]).sort((a,b) => a[0]!.localeCompare(b[0]!)));
export const clarificationPending = (task: ClarificationTask) => ["queued", "running", "proposal_ready", "no_change", "failed"].includes(task.status);
export function withUnderstandingIds(base: UnderstandingProposalV1, versionId: string): UnderstandingProposalV1 {
  const copy = structuredClone(base);
  copy.themes.forEach((theme, i) => { theme.id ??= `${versionId}:theme:${i}`; theme.claims.forEach((claim,j) => { claim.id ??= `${versionId}:claim:${i}:${j}`; }); });
  return copy;
}
export function buildClarificationCandidate(task: ClarificationTask, raw: unknown): UnderstandingProposalV1 {
  const result = clarificationResultSchema.parse(raw);
  if (task.selection) {
    const selected = topicTasksFor(task.base, "theme", task.selection.themeIndex).find(t => t.id === task.selection?.taskId);
    if (!selected || task.selection.understandingId !== task.baseUnderstandingId || JSON.stringify(selected.question) !== JSON.stringify(task.question)) throw new PitchroomError("CONFLICT", "The saved topic task no longer matches its question.");
    const owner = task.base.themes[task.selection.themeIndex]?.id;
    if (result.operations.some(op => (op.type === "add_answer" || op.type === "update_summary" || op.type === "supersede_user_assertion") && op.themeId !== owner)) throw new PitchroomError("PROPOSAL_REJECTED", "An answer cannot be attributed to a different topic.");
  }
  if ((result.schemaVersion ?? 1) < (task.result?.schemaVersion ?? 1)) throw new PitchroomError("PROPOSAL_REJECTED", "A proposal cannot be downgraded when applying edits.");
  if (task.result?.schemaVersion === 3 || task.result?.schemaVersion === 4) {
    // The editor permits summary wording only; evidence cannot be relabelled during Apply.
    const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).sort(([a],[b]) => a.localeCompare(b)).map(([key,item]) => [key,canonical(item)])) : value;
    const withoutSummaryText = (value: ClarificationResult) => JSON.stringify(canonical({ ...value, operations: value.operations.map(op => op.type === "update_summary" ? { ...op, text: "" } : op) }));
    if (withoutSummaryText(task.result) !== withoutSummaryText(result)) throw new PitchroomError("PROPOSAL_REJECTED", "Only summary text may be edited on this proposal.");
  }
  if (result.schemaVersion === 3) validateClarificationGrounding(task, result);
  if (result.schemaVersion === 4) validateClarificationV4(task, result);
  const next = withUnderstandingIds(task.base, task.baseUnderstandingId);
  const touched = new Set<string>();
  for (const op of result.operations) {
    const key = `${op.type}:${"claimId" in op ? op.claimId : "themeId" in op ? op.themeId : "question"}`;
    if (touched.has(key)) throw new PitchroomError("PROPOSAL_REJECTED", "Duplicate clarification operation.");
    touched.add(key);
    if (op.type === "next_question") {
      const ids = "relatedThemeIds" in op ? op.relatedThemeIds : undefined;
      if (next.topicTasks !== undefined && (!ids || ids.length !== 1)) throw new PitchroomError("PROPOSAL_REJECTED", "A topic followup requires exactly one theme.");
      if (ids && (new Set(ids).size !== ids.length || ids.some(id => !next.themes.some(t => t.id === id)))) throw new PitchroomError("PROPOSAL_REJECTED", "Invalid next-question theme association.");
      next.nextQuestion = { ...("groundingV4" in op && result.schemaVersion === 4 ? { groundingV4: { ...structuredClone(op.groundingV4), bases: selectedBases(result.bases, op.groundingV4.basisRefs) } } : {}), ...("grounding" in op ? { grounding: structuredClone(op.grounding) } : {}), question: op.question, whyItMatters: op.whyItMatters, relatedThemeIndexes: ids ? ids.map(id => next.themes.findIndex(t => t.id === id)) : next.nextQuestion.relatedThemeIndexes };
      if (next.topicTasks !== undefined) {
        next.topicTasks = next.topicTasks.filter(t => t.id !== task.selection?.taskId);
        for (const themeIndex of next.nextQuestion.relatedThemeIndexes) {
          if (next.topicTasks.length >= 5) break;
          next.topicTasks.push({ id: `${task.id}:followup:${themeIndex}`, themeIndex, question: { ...structuredClone(next.nextQuestion), relatedThemeIndexes: [themeIndex] } });
        }
      }
      continue;
    }
    const theme = next.themes.find(theme => theme.id === op.themeId);
    if (!theme) throw new PitchroomError("PROPOSAL_REJECTED", "Unknown clarification target.");
    if (op.type === "supersede_user_assertion") {
      const claim = theme.claims.find(c => c.id === op.claimId);
      if (!claim || claim.evidenceState !== "user_asserted" || claim.supersededBy || claim.userInputIds.includes(task.inputId)) throw new PitchroomError("PROPOSAL_REJECTED", "Only an active prior user assertion can be corrected.");
      if (!result.operations.some(item => item.type === "add_answer" && item.themeId === op.themeId) || !result.operations.some(item => item.type === "update_summary" && item.themeId === op.themeId)) throw new PitchroomError("PROPOSAL_REJECTED", "Correction requires the exact new answer and an updated interpretation in the same theme.");
      claim.supersededBy = { inputId: task.inputId, taskId: task.id, replacementClaimId: `${task.id}:answer:${theme.id}` };
    }
    else if (op.type === "update_summary") {
      const edited = Boolean(task.result && task.result.operations.some(original => original.type === "update_summary" && original.themeId === op.themeId && original.text !== op.text));
      const basis = "basis" in op ? op.basis : undefined;
      const v4 = "basisRefs" in op && result.schemaVersion === 4 ? { bases: selectedBases(result.bases, [...op.basisRefs, ...op.applicability.flatMap(a => a.basisRefs)]), basisRefs: structuredClone(op.basisRefs), applicability: structuredClone(op.applicability), reviewStatus: edited ? "user_edited_unreviewed" as const : "agent_proposed" as const } : undefined;
      const inputIds = v4 ? [...new Set(v4.bases.flatMap(b => b.origin === "user" ? b.inputIds : []))] : basis ? [...new Set(basis.flatMap(b => b.kind === "user_report" ? b.inputIds : []))] : [task.inputId];
      theme.summary = op.text;
      theme.summaryInterpretation = { inputIds, explanation: edited ? "User edited this interpretation. Original Agent reasoning has not been reassessed against the edited wording." : result.reason, editedByUser: edited, ...(v4 ? { groundingV4: v4 } : {}),
        ...("basis" in op ? { grounding: { basis: structuredClone(op.basis), applicability: structuredClone(op.applicability), reviewStatus: edited ? "user_edited_unreviewed" as const : "agent_proposed" as const } } : {}) };
    }
    else theme.claims.push({ id: `${task.id}:answer:${theme.id}`, statement: task.answer, evidenceState: "user_asserted", evidence: [], userInputIds: [task.inputId] });
  }
  if (next.topicTasks !== undefined && !result.operations.some(op => op.type === "next_question")) next.topicTasks = next.topicTasks.filter(t => t.id !== task.selection?.taskId);
  const validated = understandingProposalV1Schema.parse(next);
  validateProposalEvidence(validated, task.sources.flatMap(s => s.chunks));
  return validated;
}
function selectedBases(bases: ClarificationBasisV4[], refs: string[]): ClarificationBasisV4[] {
  const ids = new Set(refs);
  return structuredClone(bases.filter(b => ids.has(b.id)));
}
// A quote's existence is enforceable. Entailment and useful questioning remain
// semantic review obligations; model-provided rationales are not proof.
export function validateClarificationV4(task: ClarificationTask, result: z.infer<typeof clarificationResultV4Schema>) {
  const refError = (code: string): never => { throw new ClarificationValidationError("reference", code); };
  const judgmentError = (code: string): never => { throw new ClarificationValidationError("judgment", code); };
  const claims = task.base.themes.flatMap(t => t.claims);
  const inputs = new Map<string, string[]>([[task.inputId, [task.answer]]]);
  for (const c of claims.filter(c => !c.supersededBy)) for (const id of c.userInputIds) inputs.set(id, [...(inputs.get(id) ?? []), c.statement]);
  const bases = new Map(result.bases.map(b => [b.id,b]));
  if (bases.size !== result.bases.length) refError("DUPLICATE_BASIS_ID");
  const canonicalBases = result.bases.map(({id, ...content}) => JSON.stringify(content));
  if (new Set(canonicalBases).size !== canonicalBases.length) refError("DUPLICATE_BASIS_CONTENT");
  const used = new Set<string>();
  const checkRefs = (ids: string[]) => {
    if (new Set(ids).size !== ids.length || ids.some(id => !bases.has(id))) refError("INVALID_BASIS_REFERENCE");
    ids.forEach(id => used.add(id));
  };
  for (const b of result.bases) {
    if (b.origin === "material") for (const e of b.evidence) {
      const chunk = task.sources.find(s => s.id === e.sourceId && s.projectId === task.projectId)?.chunks.find(c => c.id === e.chunkId && c.sourceId === e.sourceId);
      if (!chunk || !chunk.text.includes(e.quote)) refError("INVALID_SOURCE_QUOTE");
    }
    if (b.origin === "user" && (new Set(b.inputIds).size !== b.inputIds.length || b.inputIds.some(id => !inputs.has(id)))) refError("INVALID_USER_REFERENCE");
    if (b.nature !== "requirement" && b.requirement !== null) judgmentError("NON_REQUIREMENT_HAS_CONSTRAINT");
    if (b.nature === "requirement") {
      if (b.origin === "agent" || !b.requirement) judgmentError("UNSUPPORTED_REQUIREMENT");
      const quote = b.requirement!.supportingQuote;
      if (b.origin === "material" && !b.evidence.some(e => e.quote.includes(quote))) refError("REQUIREMENT_QUOTE_NOT_CITED");
      if (b.origin === "user" && !b.inputIds.some(id => inputs.get(id)?.some(text => text.includes(quote)))) refError("REQUIREMENT_QUOTE_NOT_REPORTED");
    }
  }
  checkRefs(result.reasonBasisRefs);
  for (const op of result.operations) {
    if (op.type === "update_summary") {
      checkRefs(op.basisRefs);
      const materialClaims = (task.base.themes.find(t => t.id === op.themeId)?.claims ?? []).filter(c => c.evidence.length);
      if (new Set(op.applicability.map(a => a.claimId)).size !== op.applicability.length || op.applicability.some(a => !materialClaims.some(c => c.id === a.claimId)) || materialClaims.some(c => !op.applicability.some(a => a.claimId === c.id))) refError("INVALID_APPLICABILITY_COVERAGE");
      for (const a of op.applicability) {
        checkRefs(a.basisRefs);
        if (a.status === "confirmed" && a.basisRefs.every(id => bases.get(id)?.origin === "agent")) judgmentError("APPLICABILITY_WITHOUT_ATTRIBUTION");
      }
    }
    if (op.type === "next_question") {
      const g = op.groundingV4, ids = g.associations.map(a => a.themeId);
      if (!op.relatedThemeIds.includes(g.primaryThemeId) || new Set(ids).size !== ids.length || ids.length !== op.relatedThemeIds.length || ids.some(id => !op.relatedThemeIds.includes(id) || !task.base.themes.some(t => t.id === id))) refError("INVALID_QUESTION_ASSOCIATION");
      for (const a of g.associations) if (!op.question.includes(a.questionSpan)) refError("QUESTION_SPAN_NOT_PRESENT");
      checkRefs(g.basisRefs);
    }
  }
  if (result.bases.some(b => !used.has(b.id))) refError("UNUSED_BASIS_ENTRY");
}
// Existence and attribution checks, never a claim of semantic correctness.
function validateClarificationGrounding(task: ClarificationTask, result: z.infer<typeof clarificationResultV3Schema>) {
  const reject = (message: string): never => { throw new PitchroomError("PROPOSAL_REJECTED", message); };
  const allClaims = task.base.themes.flatMap(t => t.claims);
  const inputs = new Set([task.inputId, ...allClaims.filter(c => !c.supersededBy).flatMap(c => c.userInputIds)]);
  const validateBasis = (basis: ClarificationBasis[]) => {
    for (const b of basis) {
      if (b.kind === "user_report" && (new Set(b.inputIds).size !== b.inputIds.length || b.inputIds.some(id => !inputs.has(id)))) reject("Unknown or superseded user input in clarification basis.");
      if (b.kind === "material") for (const e of b.evidence) {
        const source = task.sources.find(s => s.id === e.sourceId && s.projectId === task.projectId);
        const chunk = source?.chunks.find(c => c.id === e.chunkId && c.sourceId === e.sourceId);
        if (!chunk || !chunk.text.includes(e.quote)) reject("Invalid source quote in clarification basis.");
      }
    }
  };
  validateBasis(result.reasonBasis);
  for (const op of result.operations) {
    if (op.type === "update_summary") {
      validateBasis(op.basis);
      const claims = task.base.themes.find(t => t.id === op.themeId)?.claims ?? [];
      if (new Set(op.applicability.map(a => a.claimId)).size !== op.applicability.length) reject("Duplicate applicability claim.");
      for (const item of op.applicability) {
        const claim = claims.find(c => c.id === item.claimId);
        if (!claim || !claim.evidence.length) reject("Applicability must reference an existing material claim in the target theme.");
        validateBasis(item.basis);
        if (item.status === "confirmed" && item.basis.every(b => b.kind === "agent_inference")) reject("Applicability confirmation needs attributed support.");
      }
      const materialClaims = claims.filter(c => c.evidence.length);
      if (materialClaims.some(c => !op.applicability.some(a => a.claimId === c.id))) reject("Updated summaries must address each preserved material claim's current applicability.");
    }
    if (op.type === "next_question") {
      const g = op.grounding;
      const ids = g.associations.map(a => a.themeId);
      if (!op.relatedThemeIds.includes(g.primaryThemeId) || new Set(ids).size !== ids.length || ids.length !== op.relatedThemeIds.length || ids.some(id => !op.relatedThemeIds.includes(id))) reject("Question grounding must explain exactly its associated themes and primary theme.");
      validateBasis(g.basis);
    }
  }
}
export function assertClarificationFresh(task: ClarificationTask, current: { phase: string; revision: number; understandingId?: string; sources: SourceRecord[] }) {
  if (current.phase !== (task.basePhase ?? "review_required") || current.revision !== task.baseRevision || current.understandingId !== task.baseUnderstandingId || sourceFingerprint(current.sources) !== task.sourceFingerprint) throw new PitchroomError("CONFLICT", "Clarification inputs changed. Rebase before applying.");
}
export function newClarification(input: { id: string; inputId: string; projectId: string; commandId: string; actorId: string; versionId: string; revision: number; basePhase?: "accepted" | "review_required"; base: UnderstandingProposalV1; sources: SourceRecord[]; answer: string; selection?: TopicTaskSelection; runMode?: "synthetic" | "live"; reassessment?: ReassessmentContext }): ClarificationTask {
  const selection = input.selection;
  const selected = selection ? topicTasksFor(input.base, "theme", selection.themeIndex).find(t => t.id === selection.taskId) : undefined;
  if (selection && (selection.understandingId !== input.versionId || !selected)) throw new PitchroomError("CONFLICT", "Choose a current question belonging to this topic.");
  if (!selection && input.base.topicTasks !== undefined) throw new PitchroomError("CONFLICT", "Select a topic task before answering.");
  return { id: input.id, createdAt: new Date().toISOString(), runMode: input.runMode ?? "synthetic", projectId: input.projectId, inputId: input.inputId, commandId: input.commandId, actorId: input.actorId, baseUnderstandingId: input.versionId, baseRevision: input.revision, basePhase: input.basePhase ?? "review_required", sourceFingerprint: sourceFingerprint(input.sources), answer: input.answer, question: structuredClone(selected?.question ?? input.base.nextQuestion), ...(selection ? { selection: structuredClone(selection) } : {}), ...(input.reassessment ? { reassessment: structuredClone(input.reassessment) } : {}), base: withUnderstandingIds(input.base, input.versionId), sources: structuredClone(input.sources), status: "queued", attempts: [{ id: `${input.id}:attempt:1`, commandId: input.commandId, status: "queued", model: "pending", promptVersion: "clarify-feedback-v4" }] };
}

export const clarificationTaskSchema = z.object({
  id: z.string(), createdAt: z.string(), runMode: z.enum(["synthetic","live"]), projectId: z.string(), inputId: z.string(), commandId: z.string(), actorId: z.string(),
  baseUnderstandingId: z.string(), baseRevision: z.number().int(), basePhase: z.enum(["accepted", "review_required"]).optional(), sourceFingerprint: z.string(),
  selection: topicTaskSelectionSchema.optional(),
  reassessment: reassessmentSchema.optional(),
  answer: z.string(), question: understandingProposalV1Schema.shape.nextQuestion,
  base: understandingProposalV1Schema,
  sources: z.array(z.object({ id: z.string(), projectId: z.string(), name: z.string(), mediaType: z.string(), contentHash: z.string(), chunks: z.array(z.object({ id: z.string(), sourceId: z.string(), text: z.string(), startOffset: z.number(), endOffset: z.number() })) })),
  status: z.enum(["queued","running","proposal_ready","no_change","failed","stale","applied","dismissed"]),
  attempts: z.array(z.object({ id: z.string(), commandId: z.string(), status: z.enum(["queued","running","completed","failed"]), startedAt: z.string().optional(), finishedAt: z.string().optional(), model: z.string(), promptVersion: z.string(), error: z.string().optional(), failure: clarificationFailureSchema.optional() })),
  result: clarificationResultSchema.optional(), appliedResult: clarificationResultSchema.optional(), candidate: understandingProposalV1Schema.optional(), leaseUntil: z.string().optional(), resultVersionId: z.string().optional(), decisionCommandId: z.string().optional(), decisionRequest: z.string().optional(),
});

export function startClarificationAttempt(task: ClarificationTask, model: string, now = Date.now()): boolean {
  const at = new Date(now).toISOString();
  if (task.status === "running") {
    Object.assign(task.attempts.at(-1)!, { status: "failed", error: "Worker lease expired", finishedAt: at });
    if (task.attempts.length >= 3) { task.status = "failed"; task.attempts.at(-1)!.error = "Worker recovery limit reached"; return false; }
    task.attempts.push({ id: `${task.id}:attempt:${task.attempts.length+1}`, commandId: `lease-recovery-${task.attempts.length+1}`, status: "queued", model, promptVersion: "clarify-feedback-v4" });
  }
  task.status = "running"; task.leaseUntil = new Date(now+90000).toISOString();
  Object.assign(task.attempts.at(-1)!, { status: "running", startedAt: at, model, promptVersion: "clarify-feedback-v4" }); return true;
}
export function ownsClarificationAttempt(current: ClarificationTask, claimed: ClarificationTask): boolean {
  return current.status === "running" && current.attempts.at(-1)?.id === claimed.attempts.at(-1)?.id;
}

// Rebase lineage is captured server-side from snapshots, never supplied by a model.
export function buildReassessmentContext(prior: ClarificationTask, sources: SourceRecord[]): ReassessmentContext {
  const before = new Map(prior.sources.map(s => [s.id, s.contentHash]));
  const after = new Map(sources.map(s => [s.id, s.contentHash]));
  return { rebasedFromTaskId: prior.id, originalUnderstandingId: prior.reassessment?.originalUnderstandingId ?? prior.baseUnderstandingId,
    originalQuestion: structuredClone(prior.reassessment?.originalQuestion ?? prior.question),
    sourceChanges: { added: sources.filter(s => !before.has(s.id)).map(s=>s.id), removed: prior.sources.filter(s=>!after.has(s.id)).map(s=>s.id), changed: sources.filter(s=>before.has(s.id) && before.get(s.id)!==s.contentHash).map(s=>s.id) } };
}
