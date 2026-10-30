import { z } from "zod";
import { appendWorkflowReview, readWorkflowReviewContext, type WorkflowReviewContext } from "./workflow";
import { hashTaskValue, sha256Schema, taskRubric, reviewBindingSchema } from "./schema";

const text = z.string().trim().min(1).max(20_000);
const id = text.max(200);
const time = z.string().datetime({ offset: true });
const authoritySchema = z.object({
  kind: z.literal("review_authority"), id, at: time, operatorEvidenceRef: text,
  mode: z.enum(["assisted_self_test", "observed_external", "scripted_synthetic"]),
  actors: z.array(z.object({ actorId: id, personId: id, role: z.enum(["human", "generator", "advisory"]),
    permissions: z.array(z.enum(["review", "adjudicate", "material_owner", "capture_provider"])),
  }).strict()).min(1),
}).strict().superRefine((value, ctx) => {
  if (new Set(value.actors.map(actor => actor.actorId)).size !== value.actors.length) ctx.addIssue({ code: "custom", message: "Duplicate actor" });
  if (value.actors.some(actor => actor.role !== "human" && actor.permissions.length)) ctx.addIssue({ code: "custom", message: "Only declared humans may make decisive reviews" });
});
const scalarSchema = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const fieldSchema = z.object({ pointer: text, value: scalarSchema, valueHash: sha256Schema, classification: z.enum(["prose", "structural"]), exemption: z.string().nullable() }).strict();
export type ReviewField = z.infer<typeof fieldSchema>;

function pointerPart(key: string) { return key.replaceAll("~", "~0").replaceAll("/", "~1"); }
/** Enumerates every scalar; unknown strings default to prose rather than disappearing. */
export function inventoryReviewFields(value: unknown): ReviewField[] {
  const data = z.json().parse(value), fields: ReviewField[] = [];
  const visit = (item: z.infer<ReturnType<typeof z.json>>, pointer: string, key: string): void => {
    if (Array.isArray(item)) { item.forEach((child, index) => visit(child, `${pointer}/${index}`, key)); return; }
    if (item !== null && typeof item === "object") { for (const [name, child] of Object.entries(item)) visit(child, `${pointer}/${pointerPart(name)}`, name); return; }
    const structural = item === null || key === "schemaVersion";
    fields.push({ pointer: pointer || "/", value: item, valueHash: hashTaskValue(item), classification: structural ? "structural" : "prose", exemption: structural ? "Structural scalar; preserved in exact output binding." : null });
  };
  visit(data, "", ""); return fields;
}
export function targetAt(context: WorkflowReviewContext, checkpointHash: string) {
  const selected = context.snapshots.find(item => item.checkpointHash === checkpointHash);
  if (!selected) throw new Error("REVIEW_CHECKPOINT_NOT_IN_WORKFLOW");
  const { workspace, input } = selected;
  const operation = context.operations.find(item => item.checkpointHash === checkpointHash)?.operation;
  let identity: { kind: string; id: string | null; generation: number | null } = { kind: input.stage, id: null, generation: null };
  let output: unknown;
  switch (input.stage) {
    case "materials": if (!workspace.sources.length) throw new Error("REVIEW_OUTPUT_MISSING"); output = { sources: workspace.sources, brief: workspace.brief }; break;
    case "understanding": output = workspace.versions.find(item => item.id === workspace.currentVersionId)?.proposal; break;
    case "clarify": if (!workspace.clarifications?.length) throw new Error("REVIEW_OUTPUT_MISSING"); output = workspace.clarifications; break;
    case "positioning": output = workspace.positioning; break;
    case "story_initial": case "story_revision": {
      const story = workspace.story;
      const candidate = operation?.command.action === "propose_story" ? story?.proposals.find(item => item.commandId === operation.command.commandId) : undefined;
      const result = candidate?.savedResult ?? candidate?.state;
      const adopted = story?.versions.find(item => item.id === story.head.storyId);
      if (candidate && result?.kind === "ready") {
        output = { story: result.candidate, responseToJudgment: result.responseToJudgment };
        identity = { kind: "candidate", id: candidate.id, generation: candidate.baseHead.generation };
      } else {
        output = adopted?.story;
        identity = { kind: "adopted_story", id: adopted?.id ?? null, generation: story?.head.generation ?? null };
      }
      break;
    }
    case "deck": case "actual_use": output = workspace.deck?.proposal; identity = { kind: workspace.deck?.createdBy === "user" ? "manual_deck" : "derived_deck", id: workspace.deck?.id ?? null, generation: workspace.deck?.number ?? null }; break;
    default: { const exhaustive: never = input.stage; throw new Error(`REVIEW_STAGE_${exhaustive}`); }
  }
  if (output === undefined || output === null) throw new Error("REVIEW_OUTPUT_MISSING");
  const parsed = z.json().parse(output);
  const binding = reviewBindingSchema.parse({ checkpointHash, outputHash: hashTaskValue(parsed), caseBinding: context.bundle.binding, codeFingerprintHash: hashTaskValue(context.manifest.identity.source),
    promptFingerprintHash: hashTaskValue({ recorded: input.promptVersion }), modelConfigHash: hashTaskValue({ recorded: input.model, usage: input.usage }),
  });
  return { binding, identity, stage: input.stage, output: parsed, fields: inventoryReviewFields(parsed), oracle: context.bundle.oracle.items.filter(item => item.applicableStages.includes(input.stage)) };
}
export function reviewAuthority(context: WorkflowReviewContext) {
  const records = context.records.filter(record => record.data && typeof record.data === "object" && !Array.isArray(record.data) && record.data.kind === "review_authority");
  if (records.length !== 1) throw new Error("REVIEW_AUTHORITY_REQUIRED");
  return authoritySchema.parse(records[0]?.data);
}
export function reviewEvidenceSources(context: WorkflowReviewContext) {
  const materials = context.bundle.fixture.sources.map(source => ({ sourceId: source.id, sourceHash: hashTaskValue(source), text: source.material, nature: "material" as const, action: null, at: null }));
  const statements = context.decisions.flatMap(decision => {
    if (!context.resolvedDecisionIds.includes(decision.decisionId) || !("originalWords" in decision.response)) return [];
    const source = { sourceId: `decision:${decision.decisionId}`, text: decision.response.originalWords, nature: "user_statement" as const, action: decision.response.kind, at: decision.at };
    return [{ ...source, sourceHash: hashTaskValue(source) }];
  });
  return [...materials, ...statements];
}
export function issueReviewPacket(rawRun: unknown, rawTarget: unknown) {
  const target = z.object({ checkpointHash: sha256Schema, actorId: id }).strict().parse(rawTarget);
  const context = readWorkflowReviewContext(rawRun); reviewRecords(context); const roles = reviewAuthority(context);
  const actor = roles.actors.find(item => item.actorId === target.actorId);
  if (!actor || actor.role !== "human" || !actor.permissions.includes("review")) throw new Error("REVIEW_ACTOR_NOT_AUTHORIZED");
  return { kind: "review_template", actorId: actor.actorId, authorityHash: hashTaskValue(roles), evidenceSources: reviewEvidenceSources(context), ...targetAt(context, target.checkpointHash) };
}

const supportSchema = z.enum(["direct_support", "bounded_inference", "insufficient_support", "contradicted"]);
const judgmentSchema = z.object({ preserved: z.boolean(), reason: text }).strict();
const claimSchema = z.object({
  claimId: id, checkpointHash: sha256Schema, location: z.object({ pointer: text, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict(),
  text, nature: z.enum(["fact", "goal", "recommendation", "reported", "inference", "hypothesis"]),
  evidenceRefs: z.array(z.object({ sourceId: id, sourceHash: sha256Schema, quote: text, start: z.number().int().nonnegative(), end: z.number().int().positive() }).strict()),
  supportVerdict: supportSchema, conditions: judgmentSchema, time: judgmentSchema, attribution: judgmentSchema, certainty: judgmentSchema,
  severity: z.enum(["critical", "noncritical"]), reviewer: id, reason: text,
}).strict();
const fieldReviewSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("no_factual_claim"), pointer: text, valueHash: sha256Schema, readWholeField: z.literal(true), reason: text }).strict(),
  z.object({ kind: z.literal("claims"), pointer: text, valueHash: sha256Schema, readWholeField: z.literal(true), allKeyClaimsExtracted: z.literal(true), claims: z.array(claimSchema).min(1) }).strict(),
]);
const packetSchema = z.object({
  kind: z.literal("review_packet"), id, at: time, actorId: id, authorityHash: sha256Schema, calibrationHash: sha256Schema, emptyFieldReason: text.nullable().optional(),
  binding: reviewBindingSchema, fields: z.array(fieldReviewSchema),
  oracle: z.array(z.object({ oracleId: id, verdict: z.enum(["preserved", "violated", "disputed"]), fieldPointers: z.array(text), reason: text }).strict()),
  scores: z.array(z.object({ dimension: text, score: z.number().int().min(0).max(4), reason: text }).strict()),
  directionDifference: z.string(), assistance: z.array(text),
}).strict();
export const calibrationBank = [
  { id: "supported", source: "The observed sample contained twelve interviews.", output: "The observed sample contained twelve interviews.", expected: "direct_support" },
  { id: "bounded", source: "Three pilot teams asked for simpler reporting.", output: "These three pilot requests suggest simpler reporting may help this pilot; broader demand is unknown.", expected: "bounded_inference" },
  { id: "target_upgrade", source: "Our target is to reduce costs by 20%.", output: "We have reduced costs by 20%.", expected: "contradicted" },
  { id: "attribution_upgrade", source: "The consultant suggested asking procurement about a pilot.", output: "Procurement approved our pilot.", expected: "contradicted" },
] satisfies { id: string; source: string; output: string; expected: z.infer<typeof supportSchema> }[];
const calibrationSchema = z.object({ kind: z.literal("review_calibration"), id, at: time, actorId: id, authorityHash: sha256Schema, bankHash: sha256Schema,
  answers: z.array(z.object({ caseId: id, supportVerdict: supportSchema, reason: text }).strict()),
}).strict();
const adjudicationSchema = z.object({ kind: z.literal("review_adjudication"), id, at: time, actorId: id, authorityHash: sha256Schema, binding: reviewBindingSchema,
  findingKey: sha256Schema, packetHashes: z.array(sha256Schema).min(1), verdict: z.enum(["preserved", "violated", "disputed"]), reason: text,
}).strict();
const useSchema = z.object({ kind: z.literal("review_use"), id, at: time, actorId: id, authorityHash: sha256Schema, binding: reviewBindingSchema,
  scope: z.enum(["assisted_self_test", "observed_external"]), observation: text, actualUse: z.boolean(),
  evidenceKind: z.enum(["synthetic", "real"]), downstreamUse: z.array(z.object({ reference: text, contentHash: sha256Schema }).strict()),
  outcome: z.enum(["useful", "not_useful"]),
  understandsDirectionDifference: z.boolean(), distinguishesPreviewAndApply: z.boolean(), completedFeedbackAndApply: z.boolean(),
  behaviorEvidence: z.array(z.object({ reference: text, contentHash: sha256Schema }).strict()),
}).strict();
const captureSchema = z.object({ kind: z.literal("provider_capture"), id, at: time, actorId: id, authorityHash: sha256Schema,
  producer: z.literal("synthetic_test_collector_v1"), sessionId: z.string().uuid(), sourceHash: sha256Schema, runtimeHash: sha256Schema, projectId: id,
  commandId: id, fromCheckpoint: sha256Schema, toCheckpoint: sha256Schema, startMarker: sha256Schema,
  events: z.array(z.object({ sequence: z.number().int().nonnegative(), previous: sha256Schema, callId: id, kind: z.enum(["call_started", "call_finished"]), hash: sha256Schema }).strict()),
  terminal: z.object({ count: z.number().int().nonnegative(), previous: sha256Schema, hash: sha256Schema }).strict(),
}).strict();
const recordSchema = z.discriminatedUnion("kind", [authoritySchema, calibrationSchema, packetSchema, adjudicationSchema, useSchema, captureSchema]);
export type ReviewRecord = z.infer<typeof recordSchema>;
export type ReviewPacket = z.infer<typeof packetSchema>;
export type ReviewAdjudication = z.infer<typeof adjudicationSchema>;
export type ProviderCapture = z.infer<typeof captureSchema>;
export type ReviewTarget = ReturnType<typeof targetAt>;

function sameInventory(actual: readonly string[], expected: readonly string[], reason: string) {
  if (new Set(actual).size !== actual.length || actual.length !== expected.length || actual.some(item => !expected.includes(item))) throw new Error(reason);
}
function authorize(context: WorkflowReviewContext, input: { actorId: string; authorityHash: string }, permission: "review" | "adjudicate" | "capture_provider") {
  const roles = reviewAuthority(context), actor = roles.actors.find(item => item.actorId === input.actorId);
  if (hashTaskValue(roles) !== input.authorityHash || !actor || actor.role !== "human" || !actor.permissions.includes(permission)) throw new Error("REVIEW_ACTOR_NOT_AUTHORIZED");
  if (permission === "adjudicate" && !actor.permissions.includes("material_owner")) throw new Error("REVIEW_MATERIAL_OWNER_REQUIRED");
  return actor;
}
function parsedReviewRecords(context: WorkflowReviewContext): ReviewRecord[] {
  return context.records.map(item => recordSchema.parse(item.data));
}
export function calibrationPassed(input: z.infer<typeof calibrationSchema>) {
  return input.bankHash === hashTaskValue(calibrationBank) && input.answers.length === calibrationBank.length && new Set(input.answers.map(item => item.caseId)).size === calibrationBank.length
    && calibrationBank.every(item => input.answers.some(answer => answer.caseId === item.id && answer.supportVerdict === item.expected));
}
function targetBinding(context: WorkflowReviewContext, binding: z.infer<typeof reviewBindingSchema>) {
  const target = targetAt(context, binding.checkpointHash);
  if (hashTaskValue(target.binding) !== hashTaskValue(binding)) throw new Error("REVIEW_BINDING_MISMATCH");
  return target;
}
export function validSpan(value: string, start: number, end: number, text: string) {
  const splitsPair = (position: number) => position > 0 && position < value.length && /[\uD800-\uDBFF]/.test(value.charAt(position - 1)) && /[\uDC00-\uDFFF]/.test(value.charAt(position));
  return Number.isInteger(start) && Number.isInteger(end) && start >= 0 && start < end && end <= value.length && !splitsPair(start) && !splitsPair(end) && value.slice(start, end) === text;
}
function validatePacket(context: WorkflowReviewContext, packet: ReviewPacket) {
  if (!packet.fields.length && !packet.emptyFieldReason) throw new Error("REVIEW_EMPTY_FIELDS_REASON_REQUIRED");
  const actor = authorize(context, packet, "review"), target = targetBinding(context, packet.binding);
  const records = parsedReviewRecords(context), calibration = records.find(item => item.kind === "review_calibration" && hashTaskValue(item) === packet.calibrationHash);
  if (!calibration || calibration.kind !== "review_calibration" || calibration.actorId !== actor.actorId || !calibrationPassed(calibration)) throw new Error("REVIEW_CALIBRATION_REQUIRED");
  const prose = target.fields.filter(field => field.classification === "prose");
  sameInventory(packet.fields.map(item => item.pointer), prose.map(item => item.pointer), "REVIEW_FIELD_COVERAGE");
  const claimIds = new Set<string>();
  for (const field of packet.fields) {
    const expected = prose.find(item => item.pointer === field.pointer);
    if (!expected || expected.valueHash !== field.valueHash) throw new Error("REVIEW_FIELD_BINDING");
    if (field.kind !== "claims") continue;
    for (const claim of field.claims) {
      if (claimIds.has(claim.claimId)) throw new Error("REVIEW_DUPLICATE_CLAIM"); claimIds.add(claim.claimId);
      if (claim.checkpointHash !== target.binding.checkpointHash || claim.reviewer !== packet.actorId || claim.location.pointer !== field.pointer || !validSpan(typeof expected.value === "string" ? expected.value : JSON.stringify(expected.value), claim.location.start, claim.location.end, claim.text)) throw new Error("REVIEW_CLAIM_SPAN");
      for (const evidence of claim.evidenceRefs) {
        const source = reviewEvidenceSources(context).find(item => item.sourceId === evidence.sourceId);
        if (!source || source.sourceHash !== evidence.sourceHash || !validSpan(source.text, evidence.start, evidence.end, evidence.quote)) throw new Error("REVIEW_SOURCE_QUOTE");
        if (source.nature === "user_statement" && claim.nature === "fact" && claim.supportVerdict === "direct_support") throw new Error("REVIEW_USER_STATEMENT_NOT_VERIFIED_FACT");
      }
      if (["direct_support", "bounded_inference"].includes(claim.supportVerdict) && !claim.evidenceRefs.length) throw new Error("REVIEW_SUPPORTED_CLAIM_WITHOUT_SOURCE");
    }
  }
  sameInventory(packet.oracle.map(item => item.oracleId), target.oracle.map(item => item.id), "REVIEW_ORACLE_COVERAGE");
  for (const item of packet.oracle) {
    const rule = target.oracle.find(rule => rule.id === item.oracleId);
    if (item.fieldPointers.some(pointer => !target.fields.some(field => field.pointer === pointer))) throw new Error("REVIEW_ORACLE_UNKNOWN_FIELD");
    if (rule?.kind === "must_preserve" && item.verdict === "preserved" && !item.fieldPointers.length) throw new Error("REVIEW_ORACLE_OMISSION");
  }
  const dispositions = new Map<string, string>();
  for (const finding of packetFindings(packet, target)) {
    const disposition = hashTaskValue({ verdict: finding.verdict, critical: finding.critical });
    const prior = dispositions.get(finding.key);
    if (prior && prior !== disposition) throw new Error("REVIEW_INCONSISTENT_FINDING");
    dispositions.set(finding.key, disposition);
  }
  const dimensions: readonly string[] = target.stage === "positioning" ? [...taskRubric.positioning.dimensions] : ["story_initial", "story_revision", "deck"].includes(target.stage) ? [...taskRubric.storyDeck.dimensions] : [];
  if (new Set(packet.scores.map(item => item.dimension)).size !== packet.scores.length || packet.scores.some(item => !dimensions.includes(item.dimension))) throw new Error("REVIEW_SCORE_DIMENSIONS");
  const roles = reviewAuthority(context);
  if (records.some(item => item.kind === "review_packet" && item.id !== packet.id && item.binding.outputHash === packet.binding.outputHash && item.binding.checkpointHash === packet.binding.checkpointHash && roles.actors.find(entry => entry.actorId === item.actorId)?.personId === actor.personId)) throw new Error("REVIEW_PERSON_ALREADY_RECORDED");
}
export function packetFindings(packet: ReviewPacket, target: ReviewTarget) {
  const claims = packet.fields.flatMap(field => field.kind === "claims" ? field.claims : []);
  return [...claims.map(claim => ({
    key: hashTaskValue({ binding: packet.binding, location: claim.location }), critical: claim.severity === "critical",
    verdict: ["insufficient_support", "contradicted"].includes(claim.supportVerdict) || [claim.conditions, claim.time, claim.attribution, claim.certainty].some(item => !item.preserved) ? "violated" : "preserved", reason: claim.reason,
  })), ...packet.oracle.map(item => ({ key: hashTaskValue({ binding: packet.binding, oracleId: item.oracleId }), critical: target.oracle.find(rule => rule.id === item.oracleId)?.severity === "critical", verdict: item.verdict, reason: item.reason }))];
}
function validateReviewRecord(context: WorkflowReviewContext, input: ReviewRecord) {
    const records = parsedReviewRecords(context);
    if (input.kind === "review_authority") {
      const existing = records.find(item => item.kind === "review_authority");
      if (existing && hashTaskValue(existing) !== hashTaskValue(input)) throw new Error("REVIEW_AUTHORITY_FROZEN");
      if (input.mode !== context.bundle.taskCase.spec.participantMode) throw new Error("REVIEW_AUTHORITY_MODE_MISMATCH");
    } else {
      authorize(context, input, input.kind === "review_adjudication" ? "adjudicate" : input.kind === "provider_capture" ? "capture_provider" : "review");
      if (input.kind === "review_packet") validatePacket(context, input);
      if (input.kind === "review_calibration") {
        if (input.bankHash !== hashTaskValue(calibrationBank)) throw new Error("REVIEW_CALIBRATION_BANK");
        sameInventory(input.answers.map(item => item.caseId), calibrationBank.map(item => item.id), "REVIEW_CALIBRATION_COVERAGE");
      }
      if (input.kind === "review_adjudication") {
        const target = targetBinding(context, input.binding);
        const referenced = records.filter(item => item.kind === "review_packet" && input.packetHashes.includes(hashTaskValue(item)));
        if (new Set(input.packetHashes).size !== input.packetHashes.length || referenced.length !== input.packetHashes.length || referenced.some(item => item.kind !== "review_packet" || hashTaskValue(item.binding) !== hashTaskValue(input.binding) || !packetFindings(item, target).some(finding => finding.key === input.findingKey))) throw new Error("REVIEW_ADJUDICATION_BINDING");
        const allRelevant = records.filter(item => item.kind === "review_packet" && hashTaskValue(item.binding) === hashTaskValue(input.binding) && packetFindings(item, target).some(finding => finding.key === input.findingKey));
        sameInventory(input.packetHashes, allRelevant.map(hashTaskValue), "REVIEW_ADJUDICATION_MISSING_REASON");
        if (records.some(item => item.kind === "review_adjudication" && item.findingKey === input.findingKey && hashTaskValue(item.binding) === hashTaskValue(input.binding) && hashTaskValue([...item.packetHashes].sort()) === hashTaskValue([...input.packetHashes].sort()) && item.id !== input.id)) throw new Error("REVIEW_ADJUDICATION_ALREADY_RECORDED");
      }
      if (input.kind === "review_use") {
        const target = targetBinding(context, input.binding), snapshot = context.snapshots.find(item => item.checkpointHash === target.binding.checkpointHash);
        if (!snapshot?.workspace.deck || snapshot.workspace.deck.stale || input.binding.outputHash !== hashTaskValue(snapshot.workspace.deck.proposal)) throw new Error("REVIEW_USE_REQUIRES_CURRENT_DECK");
        if (input.scope !== context.bundle.taskCase.spec.participantMode) throw new Error("REVIEW_USE_MODE");
        if (input.actualUse && !input.downstreamUse.length) throw new Error("REVIEW_USE_EVIDENCE_REQUIRED");
      }
      if (input.kind === "provider_capture" && context.manifest.purpose !== "tool_validation") throw new Error("REVIEW_TEST_COLLECTOR_NOT_REAL_EVIDENCE");
    }
 }
export function reviewRecords(context: WorkflowReviewContext): ReviewRecord[] {
  const validated: ReviewRecord[] = [];
  for (const [index, envelope] of context.records.entries()) {
    const input = recordSchema.parse(envelope.data);
    const checkpoint = "binding" in input ? input.binding.checkpointHash : input.kind === "provider_capture" ? input.toCheckpoint : null;
    if (envelope.id !== `review:${input.id}` || envelope.at !== input.at || envelope.checkpointHash !== checkpoint) throw new Error("REVIEW_ENVELOPE_MISMATCH");
    validateReviewRecord({ ...context, records: context.records.slice(0, index) }, input);
    validated.push(input);
  }
  return validated;
}
/** Strict safe input parsing precedes any storage; schema errors never persist raw rejected data. */
export function recordReviewEvidence(rawRun: unknown, rawInput: unknown) {
  const input = recordSchema.parse(rawInput);
  return appendWorkflowReview(rawRun, context => {
    reviewRecords(context);
    const prior = context.records.find(record => record.id === `review:${input.id}`);
    if (!prior || hashTaskValue(prior.data) !== hashTaskValue(input)) validateReviewRecord(context, input);
    const checkpointHash = "binding" in input ? input.binding.checkpointHash : input.kind === "provider_capture" ? input.toCheckpoint : null;
    return { id: `review:${input.id}`, at: input.at, checkpointHash, data: input };
  });
}
