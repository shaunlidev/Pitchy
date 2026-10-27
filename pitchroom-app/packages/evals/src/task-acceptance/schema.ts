import { createHash } from "node:crypto";
import { z } from "zod";
import { deckProposalV2Schema, positioningProposalV1Schema, storySchema, understandingProposalV1Schema } from "@pitchroom/domain";
import { coreMessageFixtureSchema } from "../core-message-live";
import { coreMessageEvalContract } from "../core-message-contract";

const text = z.string().trim().min(1);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/).brand<"TaskAcceptanceSha256">();
const timestamp = z.string().datetime({ offset: true });
const relativePath = text.refine(value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => ["", ".", ".."].includes(part)), "Use a repository-relative path without traversal.");
export const taskStageSchema = z.enum(["materials", "understanding", "clarify", "positioning", "story_initial", "story_revision", "deck", "actual_use"]);
const stages = z.array(taskStageSchema).min(1).refine(items => new Set(items).size === items.length, "Stages must be unique.");
const sourceIds = z.array(text).min(1).refine(items => new Set(items).size === items.length, "Source IDs must be unique.");
const sourceRefSchema = z.object({ sourceId: text, quote: text }).strict();
const decisionOriginSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("source_grounded_proposal"), sourceRefs: z.array(sourceRefSchema).min(1), rationale: text }).strict(),
  z.object({ kind: z.literal("explicit_user_statement"), evidenceRef: text }).strict(),
]);
const proposedText = z.object({ value: text, origin: decisionOriginSchema }).strict();
const materialPermissionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local_evaluation_only"), evidenceRef: text, externalTransfer: z.literal("not_authorized") }).strict(),
  z.object({ kind: z.literal("unknown"), question: text }).strict(),
]);
const materialReceiptSchema = z.object({
  sourceId: text, packagePointer: text.regex(/^\/sources\/\d+$/), sourceVersion: text, sourceSha256: sha256Schema,
  sourceDate: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("known"), date: z.string().date(), evidenceRef: text }).strict(),
    z.object({ kind: z.literal("unknown"), reason: text }).strict(),
  ]),
  permission: materialPermissionSchema,
}).strict();
const requiredGenerationStages = ["materials", "understanding", "clarify", "positioning", "story_initial", "story_revision", "deck"] satisfies z.infer<typeof taskStageSchema>[];
export const taskSpecSchema = z.object({
  caseId: text, caseVersion: text, caseKind: z.enum(["real_self_test", "real_external", "synthetic"]),
  materialPackage: z.object({ path: relativePath, sha256: sha256Schema, fixtureId: text }).strict(),
  materials: z.array(materialReceiptSchema).min(1),
  audience: proposedText.nullable(), decisionGoal: proposedText.nullable(), useContext: proposedText.nullable(), originalFraming: text,
  outputLanguage: z.literal("en"), requiredStages: stages, rubricVersion: text,
  feedbackPolicy: z.object({ kind: z.literal("after_actual_output"), requirements: z.array(text).min(1) }).strict(),
  participantMode: z.enum(["assisted_self_test", "observed_external", "scripted_synthetic"]),
}).strict().superRefine((spec, context) => {
  if (new Set(spec.materials.map(item => item.sourceId)).size !== spec.materials.length) context.addIssue({ code: "custom", path: ["materials"], message: "Material receipts must have unique source IDs." });
  for (const stage of requiredGenerationStages) if (!spec.requiredStages.includes(stage)) context.addIssue({ code: "custom", path: ["requiredStages"], message: `Full-task cases must declare ${stage}; unexercised stages remain incomplete, never silently skipped.` });
  const mode = { real_self_test: "assisted_self_test", real_external: "observed_external", synthetic: "scripted_synthetic" }[spec.caseKind];
  if (spec.participantMode !== mode) context.addIssue({ code: "custom", path: ["participantMode"], message: "Participant mode must match the case's evidence boundary." });
});
export const oracleSchema = z.object({
  caseId: text, caseVersion: text, oracleVersion: text, rubricVersion: text,
  items: z.array(z.object({
    id: text, kind: z.enum(["must_preserve", "forbidden_upgrade", "unknown", "conflict"]), meaning: text,
    sourceRefs: z.array(sourceRefSchema).min(1), applicableStages: stages, severity: z.enum(["critical", "noncritical"]), rationale: text,
  }).strict()).min(1),
}).strict().superRefine((oracle, context) => {
  if (new Set(oracle.items.map(item => item.id)).size !== oracle.items.length) context.addIssue({ code: "custom", path: ["items"], message: "Oracle item IDs must be unique." });
});
export const taskRubric = {
  version: "task-acceptance-v1",
  positioning: { contractVersion: coreMessageEvalContract.version, dimensions: coreMessageEvalContract.humanRubric, minimumEach: 2, minimumMean: 3 },
  storyDeck: { dimensions: ["faithfulness_and_boundaries", "required_coverage", "judgment_and_narrative", "feedback_response", "discussion_readiness"], minimumEach: 3 },
  hardFailures: ["fabricated_or_distorted_key_fact", "certainty_or_attribution_upgrade", "material_conflict_or_unknown_hidden", "unsupported_key_claim_with_real_citation", "critical_constraint_omitted", "adoption_or_deck_mismatch"],
  scores: { minimum: 0, maximum: 4 },
  productGate: { minimumObservedParticipants: 3, minimumIndependentApply: 2, maximumPreviewApplyConfusion: 0, minimumActualDownstreamUse: 1 },
} as const;
const confirmationSchema = z.object({ actor: text, role: z.literal("material_owner_and_product_owner"), confirmedAt: timestamp, evidenceRef: text }).strict();
export const freezeBindingSchema = z.object({ specHash: sha256Schema, materialPackageHash: sha256Schema, oracleHash: sha256Schema, rubricHash: sha256Schema }).strict();
const frozenTaskSpecSchema = taskSpecSchema.safeExtend({ audience: proposedText, decisionGoal: proposedText, useContext: proposedText });
const caseCommon = { schemaVersion: z.literal(1), spec: taskSpecSchema };
export const taskCaseSchema = z.discriminatedUnion("status", [
  z.object({ ...caseCommon, status: z.literal("draft"), openDecisions: z.array(z.object({ id: text, question: text, recommendation: text }).strict()).min(1) }).strict(),
  z.object({ ...caseCommon, spec: frozenTaskSpecSchema, status: z.literal("frozen"), binding: freezeBindingSchema, confirmation: confirmationSchema }).strict(),
]);
export type TaskCase = z.infer<typeof taskCaseSchema>;
export type TaskOracle = z.infer<typeof oracleSchema>;

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => [key, canonicalize(item)]));
  return value;
}
export function hashTaskValue(value: unknown) {
  const serialized = JSON.stringify(canonicalize(value));
  if (serialized === undefined) throw new Error("Cannot hash an undefined value.");
  return sha256Schema.parse(createHash("sha256").update(serialized).digest("hex"));
}
export function hashTaskBytes(bytes: string | Uint8Array) { return sha256Schema.parse(createHash("sha256").update(bytes).digest("hex")); }

export function parseTaskBundle(input: { taskCase: unknown; oracle: unknown; materialPackageText: string }) {
  const taskCase = taskCaseSchema.parse(input.taskCase);
  const oracle = oracleSchema.parse(input.oracle);
  const fixture = coreMessageFixtureSchema.parse(JSON.parse(input.materialPackageText));
  const { spec } = taskCase;
  if (hashTaskBytes(input.materialPackageText) !== spec.materialPackage.sha256 || fixture.id !== spec.materialPackage.fixtureId) throw new Error("MATERIAL_PACKAGE_MISMATCH");
  if (spec.originalFraming !== fixture.originalFraming) throw new Error("ORIGINAL_FRAMING_MISMATCH");
  if (oracle.caseId !== spec.caseId || oracle.caseVersion !== spec.caseVersion || oracle.rubricVersion !== spec.rubricVersion || spec.rubricVersion !== taskRubric.version) throw new Error("CASE_OR_RULE_VERSION_MISMATCH");
  if (spec.materials.length !== fixture.sources.length) throw new Error("MATERIAL_COVERAGE_MISMATCH");
  for (const receipt of spec.materials) {
    const index = Number(receipt.packagePointer.slice("/sources/".length));
    const source = fixture.sources[index];
    if (!source || source.id !== receipt.sourceId || hashTaskValue(source) !== receipt.sourceSha256) throw new Error("SOURCE_RECEIPT_MISMATCH");
  }
  const refs = [...oracle.items.flatMap(item => item.sourceRefs), ...[spec.audience, spec.decisionGoal, spec.useContext].flatMap(item => item?.origin.kind === "source_grounded_proposal" ? item.origin.sourceRefs : [])];
  for (const ref of refs) {
    const source = fixture.sources.find(item => item.id === ref.sourceId);
    if (!source || !source.material.includes(ref.quote)) throw new Error("SOURCE_QUOTE_MISMATCH");
  }
  for (const item of oracle.items) if (item.applicableStages.some(stage => !spec.requiredStages.includes(stage))) throw new Error("ORACLE_STAGE_OUTSIDE_CASE");
  const binding = { specHash: hashTaskValue(spec), materialPackageHash: spec.materialPackage.sha256, oracleHash: hashTaskValue(oracle), rubricHash: hashTaskValue(taskRubric) };
  if (taskCase.status === "frozen" && hashTaskValue(taskCase.binding) !== hashTaskValue(binding)) throw new Error("FROZEN_BINDING_MISMATCH");
  return { taskCase, oracle, fixture, binding, materialPackageText: input.materialPackageText };
}
export type TaskBundle = ReturnType<typeof parseTaskBundle>;

export function freezeTaskBundle(input: { bundle: TaskBundle; confirmation: unknown; binding: unknown }) {
  const bundle = parseTaskBundle(input.bundle);
  const confirmation = confirmationSchema.parse(input.confirmation);
  const binding = freezeBindingSchema.parse(input.binding);
  if (hashTaskValue(binding) !== hashTaskValue(bundle.binding)) throw new Error("CONFIRMATION_BINDING_MISMATCH");
  if (bundle.taskCase.status !== "draft") throw new Error("CASE_ALREADY_FROZEN");
  return taskCaseSchema.parse({ schemaVersion: 1, status: "frozen", spec: bundle.taskCase.spec, binding, confirmation });
}

export function previewTaskModelInput(bundle: TaskBundle) {
  const { spec } = bundle.taskCase;
  if (!spec.audience || !spec.decisionGoal || !spec.useContext) throw new Error("TASK_CONTEXT_INCOMPLETE");
  return {
    task: { audience: spec.audience.value, decisionGoal: spec.decisionGoal.value, useContext: spec.useContext.value, originalFraming: spec.originalFraming, outputLanguage: spec.outputLanguage },
    sources: bundle.fixture.sources.map(source => ({ id: source.id, authority: source.authority, url: source.url, material: source.material, boundary: source.boundary })),
  };
}
export const liveTransferApprovalSchema = z.object({
  binding: freezeBindingSchema, sourceIds, provider: text, model: text, purpose: z.literal("task_acceptance_r1"), confirmation: confirmationSchema,
}).strict();
export function requireTaskGenerationInput(input: { bundle: TaskBundle; transferApproval: unknown; provider: string; model: string }) {
  const bundle = parseTaskBundle(input.bundle);
  if (bundle.taskCase.status !== "frozen") throw new Error("CASE_NOT_FROZEN");
  const approval = liveTransferApprovalSchema.parse(input.transferApproval);
  if (hashTaskValue(approval.binding) !== hashTaskValue(bundle.binding) || approval.provider !== input.provider || approval.model !== input.model) throw new Error("TRANSFER_SCOPE_MISMATCH");
  const actual = bundle.fixture.sources.map(source => source.id).sort();
  if (JSON.stringify([...approval.sourceIds].sort()) !== JSON.stringify(actual)) throw new Error("TRANSFER_SOURCE_SCOPE_MISMATCH");
  return previewTaskModelInput(bundle);
}

export const executionStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("prepared") }).strict(),
  z.object({ kind: z.literal("running"), stage: taskStageSchema, attemptId: text }).strict(),
  z.object({ kind: z.literal("awaiting_user"), stage: taskStageSchema, checkpointHash: sha256Schema, question: text }).strict(),
  z.object({ kind: z.literal("outcome_unknown"), stage: taskStageSchema, attemptId: text, commandId: text, reason: text }).strict(),
  z.object({ kind: z.literal("completed"), checkpointHashes: z.array(sha256Schema).min(1) }).strict(),
  z.object({ kind: z.literal("failed"), stage: taskStageSchema, attemptId: text, reason: text }).strict(),
]);
export const integrityStateSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("valid"), binding: freezeBindingSchema }).strict(),
  z.object({ kind: z.literal("invalid"), reasons: z.array(text).min(1) }).strict(),
]);
export const engineeringVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pass"), checkReceiptHashes: z.array(sha256Schema).min(1) }).strict(),
  z.object({ kind: z.literal("fail"), failedCheckIds: z.array(text).min(1) }).strict(),
  z.object({ kind: z.literal("incomplete"), missingChecks: z.array(text).min(1) }).strict(),
]);
export const semanticVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pass"), reviewHashes: z.array(sha256Schema).min(1), binding: freezeBindingSchema }).strict(),
  z.object({ kind: z.literal("fail"), findingIds: z.array(text).min(1) }).strict(),
  z.object({ kind: z.literal("disputed"), disputeIds: z.array(text).min(1) }).strict(),
  z.object({ kind: z.literal("incomplete"), missingStages: stages }).strict(),
  z.object({ kind: z.literal("awaiting_review"), missingReviewIds: z.array(text).min(1) }).strict(),
]);
export const userTaskVerdictSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pass"), scope: z.enum(["assisted_self_test", "observed_external"]), observationHashes: z.array(sha256Schema).min(1), downstreamUseEvidenceHash: sha256Schema }).strict(),
  z.object({ kind: z.literal("fail"), observationHashes: z.array(sha256Schema).min(1), reason: text }).strict(),
  z.object({ kind: z.literal("awaiting_observation"), missingEvidence: z.array(text).min(1) }).strict(),
]);
export const taskAssessmentSchema = z.object({ execution: executionStateSchema, integrity: integrityStateSchema, engineering: engineeringVerdictSchema, semantic: semanticVerdictSchema, userTask: userTaskVerdictSchema }).strict().superRefine((assessment, context) => {
  if (assessment.integrity.kind === "invalid" && [assessment.engineering.kind, assessment.semantic.kind, assessment.userTask.kind].includes("pass")) context.addIssue({ code: "custom", message: "Invalid evidence cannot support a passing assessment." });
});

// Stage payloads use product contracts; PIT-51 adds persisted checkpoint envelopes.
export const productCheckpointPayloadSchema = z.discriminatedUnion("stage", [
  z.object({ stage: z.literal("understanding"), output: understandingProposalV1Schema }).strict(),
  z.object({ stage: z.literal("positioning"), output: positioningProposalV1Schema }).strict(),
  z.object({ stage: z.literal("story_initial"), output: storySchema }).strict(),
  z.object({ stage: z.literal("story_revision"), output: storySchema }).strict(),
  z.object({ stage: z.literal("deck"), output: deckProposalV2Schema }).strict(),
]);


export const reviewBindingSchema = z.object({
  caseBinding: freezeBindingSchema, checkpointHash: sha256Schema, outputHash: sha256Schema,
  codeFingerprintHash: sha256Schema, promptFingerprintHash: sha256Schema, modelConfigHash: sha256Schema,
}).strict();
export function requireMatchingReviewBinding(input: { expected: unknown; reviewed: unknown }) {
  const expected = reviewBindingSchema.parse(input.expected);
  const reviewed = reviewBindingSchema.parse(input.reviewed);
  if (hashTaskValue(expected) !== hashTaskValue(reviewed)) throw new Error("REVIEW_BINDING_MISMATCH");
  return reviewed;
}
