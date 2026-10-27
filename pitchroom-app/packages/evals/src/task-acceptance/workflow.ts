import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { hostname } from "node:os";
import { z } from "zod";
import { normalizeMaterialText, readPositioning, storyToDeck, workspaceCommandSchema, workspaceStateSchema } from "@pitchroom/domain";
import { assertUnlinkedPath, ensurePrivateDirectory, errorCode, evidenceTreeBytes, failEvidence, loadEvidencePolicy, reserveEvidenceWrite, withEvidenceLock, type EvidencePolicy } from "./capacity";
import { hashTaskBytes, hashTaskValue, parseTaskBundle, previewTaskModelInput, sha256Schema, taskStageSchema } from "./schema";
import { appendTaskCheckpoint, appendTaskObservation, captureTaskSourceIdentity, createTaskSession, taskSessionRefSchema, verifyTaskSession, type TaskSessionRef } from "./session";
import { inspectWorkspaceReceipt, IsolatedWorkspaceClient, parseWorkspaceBinding } from "./workspace-client";

const text = z.string().min(1);
const absolute = text.refine(isAbsolute);
const METADATA_BYTES = 65_536;
const runRefSchema = z.object({ referenceFile: absolute }).strict();
export type TaskWorkflowRun = z.infer<typeof runRefSchema>;
const locatorSchema = z.object({
  schemaVersion: z.literal(1), initialReference: taskSessionRefSchema,
  policyInput: z.json(), launchReceipt: z.json(), sourceRepository: absolute, caseDirectory: absolute,
}).strict();
const startedSchema = z.object({
  kind: z.literal("workflow_started"), version: z.literal(1), configurationHash: text, configuration: locatorSchema,
}).strict();
const stepSchema = z.enum(["materials", "understanding", "understanding_review", "clarification_wait", "understanding_accept", "positioning", "positioning_wording", "positioning_choice", "story_initial", "story_initial_candidate", "feedback", "story_revision", "story_revision_candidate", "deck", "deck_review", "actual_use", "finished", "stopped"]);
type Step = z.infer<typeof stepSchema>;
const ownerSchema = z.object({ host: text, pid: z.number().int().positive(), token: z.string().uuid() }).strict();
const workspaceSnapshotSchema = z.object({ kind: z.literal("workflow_workspace"), workspace: workspaceStateSchema, workspaceHash: sha256Schema }).strict();
const gateSchema = z.object({
  kind: z.literal("workflow_gate"), step: stepSchema, checkpointHash: sha256Schema, caseBindingHash: sha256Schema,
  workspaceHash: sha256Schema, choices: z.array(z.object({ key: text, text: z.string(), provenance: text }).strict()),
  allowedActions: z.array(text).min(1), capability: sha256Schema,
}).strict();
const operationSchema = z.object({
  kind: z.literal("workflow_operation"), operationId: text, operationKey: text, owner: ownerSchema,
  fromStep: stepSchema, nextStep: stepSchema, checkpointHash: sha256Schema, stage: taskStageSchema,
  command: workspaceCommandSchema, decisionId: text.nullable(),
}).strict();
const snapshotFactSchema = z.object({ kind: z.literal("workflow_snapshot"), checkpointHash: sha256Schema }).strict();
const operationDoneSchema = z.object({ kind: z.literal("workflow_operation_done"), operationId: text, checkpointHash: sha256Schema, receiptHash: sha256Schema }).strict();
const heldSchema = z.object({ kind: z.literal("workflow_held"), reason: text, operationId: text.nullable() }).strict();
const takeoverSchema = z.object({ kind: z.literal("workflow_takeover"), operationId: text, previousToken: z.string().uuid(), owner: ownerSchema }).strict();
const feedbackFields = {
  storyKey: text, observedCheckpointHash: sha256Schema, originalWords: z.string().min(1).max(10000).refine(value => Boolean(value.trim())),
  mustChange: z.array(text).max(50), mustPreserve: z.array(text).max(50), mustNot: z.array(text).max(50),
};
const humanActionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("answer_clarification"), taskKey: text, originalWords: z.string().min(1).max(10000).refine(value => Boolean(value.trim())) }).strict(),
  z.object({ kind: z.literal("apply_clarification"), candidateKey: text }).strict(),
  z.object({ kind: z.literal("dismiss_clarification"), candidateKey: text }).strict(),
  z.object({ kind: z.literal("accept_understanding"), versionKey: text }).strict(),
  z.object({ kind: z.literal("keep_unknown"), versionKey: text }).strict(),
  z.object({ kind: z.literal("not_needed"), activity: z.enum(["clarification", "story_revision"]), reason: text }).strict(),
  z.object({ kind: z.literal("choose_positioning"), choiceKey: text }).strict(),
  z.object({ kind: z.literal("edit_positioning"), directionKey: text, mode: z.enum(["headline", "judgment_note"]), originalWords: z.string().min(1).max(10000) }).strict(),
  z.object({ kind: z.literal("undo_positioning") }).strict(),
  z.object({ kind: z.literal("review_positioning") }).strict(),
  z.object({ kind: z.literal("apply_story"), candidateKey: text }).strict(),
  z.object({ kind: z.literal("keep_story"), candidateKey: text }).strict(),
  z.object({ kind: z.literal("retry_story"), candidateKey: text }).strict(),
  z.object({ kind: z.literal("feedback"), ...feedbackFields }).strict(),
  z.object({ kind: z.literal("exact_edit_story"), ...feedbackFields, blockKey: text, title: z.string().min(1).max(500), body: z.string().min(1).max(20000) }).strict(),
  z.object({ kind: z.literal("undo_story") }).strict(),
  z.object({ kind: z.literal("restore_story"), storyKey: text }).strict(),
  z.object({ kind: z.literal("edit_deck_page"), pageKey: text, title: z.string().min(1).max(500), body: z.string().min(1).max(20000) }).strict(),
  z.object({ kind: z.literal("record_review"), originalWords: text }).strict(),
  z.object({ kind: z.literal("record_use"), scope: z.enum(["assisted_self_test", "observed_external"]), activity: text, evidenceRefs: z.array(text).min(1), edits: z.array(text), activeReviewSeconds: z.number().nonnegative(), waitingSeconds: z.number().nonnegative() }).strict(),
  z.object({ kind: z.literal("use_not_observed"), reason: text }).strict(),
  z.object({ kind: z.literal("stop"), reason: text }).strict(),
]);
const decisionSchema = z.object({
  decisionId: text.max(200), actor: text.max(200), at: z.string().datetime({ offset: true }), checkpointHash: sha256Schema, capability: sha256Schema,
  assistance: z.discriminatedUnion("kind", [z.object({ kind: z.literal("none") }).strict(), z.object({ kind: z.literal("provided"), details: text, evidenceRef: text }).strict()]),
  response: humanActionSchema,
}).strict();
type Decision = z.infer<typeof decisionSchema>;
const decisionFactSchema = z.object({ kind: z.literal("workflow_decision"), decision: decisionSchema }).strict();
const decisionResolvedSchema = z.object({ kind: z.literal("workflow_decision_resolved"), decisionId: text, nextStep: stepSchema }).strict();
const decisionRejectedSchema = z.object({ kind: z.literal("workflow_decision_rejected"), decision: decisionSchema, reason: text }).strict();
const framingAvailableSchema = z.object({ kind: z.literal("workflow_framing_available"), checkpointHash: sha256Schema }).strict();
const workflowFactSchema = z.discriminatedUnion("kind", [startedSchema, gateSchema, operationSchema, snapshotFactSchema, operationDoneSchema, heldSchema, takeoverSchema, decisionFactSchema, decisionResolvedSchema, decisionRejectedSchema, framingAvailableSchema]);
type WorkflowFact = z.infer<typeof workflowFactSchema>;
type Workspace = z.infer<typeof workspaceStateSchema>;
type Operation = z.infer<typeof operationSchema>;
type CompletedOperation = { operation: Operation; checkpointHash: z.infer<typeof sha256Schema> };
type HumanBoundary = { kind: "awaiting_human"; checkpointHash: z.infer<typeof sha256Schema>; capability: z.infer<typeof sha256Schema>; step: Step; choices: z.infer<typeof gateSchema>["choices"]; allowedActions: string[]; workspace: Workspace };
type Held = { kind: "held"; reason: string; step: Step };
type OperationProgress = Held | { kind: "operation_completed" };
export type TaskWorkflowProgress = HumanBoundary | Held
  | { kind: "awaiting_product"; taskId: string; status: "queued" | "running" }
  | { kind: "resume_decision"; decisionId: string }
  | { kind: "decision_completed"; decisionId: string; nextStep: Step }
  | { kind: "stopped" | "finished"; reference: TaskSessionRef };
const stageForStep: Record<Step, z.infer<typeof taskStageSchema>> = {
  materials: "materials", understanding: "understanding", understanding_review: "understanding", clarification_wait: "clarify", understanding_accept: "understanding",
  positioning: "positioning", positioning_wording: "positioning", positioning_choice: "positioning", story_initial: "story_initial", story_initial_candidate: "story_initial", feedback: "story_initial",
  story_revision: "story_revision", story_revision_candidate: "story_revision", deck: "deck", deck_review: "deck", actual_use: "actual_use", finished: "actual_use", stopped: "actual_use",
};
const prepareSchema = z.object({
  caseDirectory: absolute, accountingPolicyFile: absolute, launchReceiptFile: absolute,
  sourceRepository: absolute, sessionId: z.string().uuid(), maximumBytes: z.number().int().min(METADATA_BYTES + 32_768),
  purpose: z.enum(["tool_validation", "task_evidence"]),
}).strict();

function readJson(path: string): unknown {
  assertUnlinkedPath(path);
  if (!lstatSync(path).isFile()) failEvidence("WORKFLOW_INPUT_NOT_FILE");
  return JSON.parse(readFileSync(path, "utf8"));
}
function readPrivateJson(path: string) {
  const value = readJson(path);
  if ((lstatSync(path).mode & 0o077) !== 0) failEvidence("WORKFLOW_INSECURE_REFERENCE");
  return value;
}
const handleRoot = (policy: EvidencePolicy, id: string) => join(policy.recordRoot, ".workflow-handles", id);
const encode = (value: unknown) => `${JSON.stringify(value)}\n`;

// Handles are outside the session tree for a separately retained rollback anchor, but inside
// globally counted artifacts. A fixed budget slice bounds their total storage per run.
function publishHandle(policy: EvidencePolicy, sessionId: string, name: string, value: unknown) {
  const bytes = encode(value), root = handleRoot(policy, sessionId), destination = join(root, name);
  return withEvidenceLock(policy, () => {
    ensurePrivateDirectory(join(policy.recordRoot, ".workflow-handles")); ensurePrivateDirectory(root);
    assertUnlinkedPath(destination);
    if (existsSync(destination)) {
      if (readFileSync(destination, "utf8") !== bytes) failEvidence("WORKFLOW_IMMUTABLE_REFERENCE_CONFLICT");
      return;
    }
    reserveEvidenceWrite(policy, { sessionRoot: root, maximumSessionBytes: METADATA_BYTES, additionalBytes: Buffer.byteLength(bytes) * 2 + 512 });
    const pending = join(root, `.pending-${randomUUID()}`), fd = openSync(pending, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    // Failed publications remain counted. Never overwrite another invocation's handle.
    linkSync(pending, destination); unlinkSync(pending);
    const directory = openSync(root, "r"); try { fsyncSync(directory); } finally { closeSync(directory); }
  });
}
function saveAnchor(policy: EvidencePolicy, reference: TaskSessionRef) {
  publishHandle(policy, reference.sessionId, `anchor-${String(reference.sequence).padStart(12, "0")}-${reference.headHash}.json`, reference);
}
function currentAnchor(policy: EvidencePolicy, initial: TaskSessionRef) {
  const root = handleRoot(policy, initial.sessionId);
  evidenceTreeBytes(root);
  const names = readdirSync(root).filter(name => name.startsWith("anchor-")).sort();
  if (!names.length) failEvidence("WORKFLOW_ANCHOR_MISSING");
  const anchors = names.map(name => {
    const match = /^anchor-([0-9]{12})-([a-f0-9]{64})\.json$/.exec(name);
    if (!match) failEvidence("WORKFLOW_INVALID_ANCHOR_NAME");
    const reference = taskSessionRefSchema.parse(readPrivateJson(join(root, name)));
    if (reference.sessionId !== initial.sessionId || reference.manifestHash !== initial.manifestHash || Number(match[1]) !== reference.sequence || match[2] !== reference.headHash) failEvidence("WORKFLOW_ANCHOR_BINDING_MISMATCH");
    return reference;
  });
  const seen = new Map<number, string>();
  for (const reference of anchors) {
    if (seen.has(reference.sequence) && seen.get(reference.sequence) !== reference.headHash) failEvidence("WORKFLOW_FORKED_ANCHOR");
    seen.set(reference.sequence, reference.headHash);
  }
  const last = anchors.at(-1); if (!last) failEvidence("WORKFLOW_ANCHOR_MISSING");
  return last;
}

function loadRun(raw: unknown) {
  const run = runRefSchema.parse(raw), locator = locatorSchema.parse(readPrivateJson(run.referenceFile));
  const policy = loadEvidencePolicy(locator.policyInput);
  if (resolve(run.referenceFile) !== join(handleRoot(policy, locator.initialReference.sessionId), "run.json")) failEvidence("WORKFLOW_REFERENCE_LOCATION_MISMATCH");
  parseWorkspaceBinding(locator.launchReceipt);
  const state = verifyTaskSession(policy, currentAnchor(policy, locator.initialReference));
  const observation = state.observations.find(item => item.id === "workflow:started");
  if (!observation) failEvidence("WORKFLOW_INITIALIZATION_MISSING");
  const started = startedSchema.parse(observation.data);
  if (started.configurationHash !== hashTaskValue(locator) || hashTaskValue(started.configuration) !== started.configurationHash) failEvidence("WORKFLOW_CONFIGURATION_CHANGED");
  // Unknown workflow versions fail closed rather than being skipped as unrelated transport data.
  const facts: WorkflowFact[] = [];
  for (const item of state.observations) {
    if (item.data && typeof item.data === "object" && !Array.isArray(item.data) && typeof item.data.kind === "string" && item.data.kind.startsWith("workflow_")) facts.push(workflowFactSchema.parse(item.data));
  }
  return { run, locator, policy, state, facts };
}
type Context = ReturnType<typeof loadRun>;
const snapshotCache = new WeakMap<Context, Map<string, z.infer<typeof workspaceSnapshotSchema>>>();

function snapshot(context: Context, hash: string) {
  if (!context.state.committed.has(hash)) failEvidence("WORKFLOW_UNCOMMITTED_CHECKPOINT");
  let cache = snapshotCache.get(context); if (!cache) { cache = new Map(); snapshotCache.set(context, cache); }
  const cached = cache.get(hash); if (cached) return cached;
  const entry = [...context.state.checkpoints.values()].find(item => item.hash === hash);
  if (!entry || entry.value.input.result.kind !== "unverified_record") failEvidence("WORKFLOW_INVALID_CHECKPOINT");
  const result = workspaceSnapshotSchema.parse(entry.value.input.result.data);
  if (hashTaskValue(result.workspace) !== result.workspaceHash) failEvidence("WORKFLOW_CHECKPOINT_CONTENT_CHANGED");
  cache.set(hash, result); return result;
}
function pendingOperation(pending: Operation | null, operationId: string): Operation {
  if (!pending || pending.operationId !== operationId) failEvidence("WORKFLOW_PENDING_OPERATION_MISMATCH");
  return pending;
}
function operationIdFor(context: Context, key: string) { return `workflow-op:${hashTaskValue({ sessionId: context.state.reference.sessionId, key })}`; }
function humanEffect(step: Step, workspace: Workspace, response: Decision["response"], commandId: string) {
  let nextStep: Step, command: object | null = null;
  const head = workspace.story?.head ?? { generation: 0, storyId: null };
  const positioning = workspace.positioning ? readPositioning(workspace.positioning) : null;
  switch (response.kind) {
    case "stop": nextStep = "stopped"; break;
    case "not_needed":
      if (step === "understanding_review" && response.activity === "clarification") nextStep = "understanding_accept";
      else if (step === "feedback" && response.activity === "story_revision" && head.storyId) nextStep = "deck";
      else failEvidence("WORKFLOW_NOT_NEEDED_SCOPE"); break;
    case "keep_unknown":
      if (response.versionKey !== workspace.currentVersionId) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "keep_unknown", expectedRevision: workspace.project.revision }; nextStep = "understanding_accept"; break;
    case "answer_clarification": {
      const version = workspace.versions.find(item => item.id === workspace.currentVersionId); if (!version) failEvidence("WORKFLOW_UNDERSTANDING_MISSING");
      const selected = version.proposal.topicTasks?.find(task => task.id === response.taskKey);
      if (!selected && (version.proposal.topicTasks?.length || response.taskKey !== "next-question")) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "submit_clarification", expectedRevision: workspace.project.revision, text: response.originalWords, ...(selected ? { selection: { understandingId: version.id, taskId: selected.id, themeIndex: selected.themeIndex } } : {}) }; nextStep = "clarification_wait"; break;
    }
    case "apply_clarification":
    case "dismiss_clarification":
      if (!workspace.clarifications?.some(task => task.id === response.candidateKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: response.kind, taskId: response.candidateKey }; nextStep = "understanding_accept"; break;
    case "accept_understanding":
      if (response.versionKey !== workspace.currentVersionId) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "accept", expectedRevision: workspace.project.revision }; nextStep = "positioning"; break;
    case "choose_positioning":
      if (!positioning?.choices.some(choice => choice.id === response.choiceKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "apply_positioning", expectedRevision: workspace.project.revision, expectedPositioning: positioning.head, directionId: response.choiceKey }; nextStep = "story_initial"; break;
    case "edit_positioning":
      if (!positioning || !workspace.positioning?.proposal.directions.some(choice => choice.id === response.directionKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "adjust_positioning", expectedRevision: workspace.project.revision, expectedPositioning: positioning.head, directionId: response.directionKey, mode: response.mode, text: response.originalWords }; nextStep = "positioning_choice"; break;
    case "undo_positioning":
      if (!positioning?.canUndo) failEvidence("WORKFLOW_NOTHING_TO_UNDO");
      command = { action: "undo_positioning", expectedRevision: workspace.project.revision, expectedPositioning: positioning.head }; nextStep = "positioning_choice"; break;
    case "review_positioning": nextStep = "positioning_choice"; break;
    case "apply_story":
    case "keep_story":
    case "retry_story": {
      const proposal = workspace.story?.proposals.find(item => item.id === response.candidateKey);
      if (!proposal) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      if (response.kind === "apply_story" && proposal.state.kind !== "ready") failEvidence("WORKFLOW_STORY_NOT_APPLICABLE");
      if (response.kind === "retry_story") {
        command = { action: "propose_story", expected: head, request: proposal.snapshot.request, retryOf: proposal.id }; nextStep = step;
      } else {
        command = { action: "decide_story", expected: head, proposalId: proposal.id, decision: response.kind === "apply_story" ? "apply" : "keep_current" };
        nextStep = step === "story_initial_candidate" ? "feedback" : "deck";
      } break;
    }
    case "feedback":
      if (!head.storyId || head.storyId !== response.storyKey || !workspace.story?.versions.some(item => item.id === response.storyKey)) failEvidence("WORKFLOW_FEEDBACK_REQUIRES_ADOPTED_STORY");
      nextStep = "story_revision"; break;
    case "exact_edit_story": {
      const adopted = workspace.story?.versions.find(item => item.id === head.storyId);
      if (!adopted || adopted.id !== response.storyKey || !adopted.story.blocks.some(block => block.id === response.blockKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "propose_story", expected: head, request: { kind: "exact_edit", blockId: response.blockKey, title: response.title, body: response.body } }; nextStep = "story_revision_candidate"; break;
    }
    case "undo_story":
      if (!head.storyId || !workspace.story?.versions.some(item => item.id === head.storyId)) failEvidence("WORKFLOW_NOTHING_TO_UNDO");
      command = { action: "undo_story", expected: head }; nextStep = "feedback"; break;
    case "restore_story":
      if (!workspace.story?.versions.some(item => item.id === response.storyKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "propose_story", expected: head, request: { kind: "restore", storyId: response.storyKey } }; nextStep = head.storyId ? "story_revision_candidate" : "story_initial_candidate"; break;
    case "edit_deck_page":
      if (!workspace.deck?.proposal.pages.some(page => page.id === response.pageKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
      command = { action: "edit_deck_page", deckId: workspace.deck.id, expectedDeckVersion: workspace.deck.number, pageId: response.pageKey, title: response.title, body: response.body }; nextStep = "deck_review"; break;
    case "record_review":
      if (!workspace.deck || workspace.deck.proposal.schemaVersion !== 2) failEvidence("WORKFLOW_STORY_DECK_REQUIRED");
      nextStep = "actual_use"; break;
    case "record_use":
    case "use_not_observed": nextStep = "finished"; break;
    default: { const exhaustive: never = response; return exhaustive; }
  }
  return { nextStep, command: command === null ? null : workspaceCommandSchema.parse({ ...command, commandId }) };
}
function validateTarget(gate: z.infer<typeof gateSchema>, decision: Decision, workspace: Workspace) {
  const response = decision.response;
  switch (response.kind) {
    case "answer_clarification":
      if (!gate.choices.some(choice => choice.key === response.taskKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH"); break;
    case "apply_clarification":
    case "dismiss_clarification":
      if (!gate.choices.some(choice => choice.key === response.candidateKey) || !workspace.clarifications?.some(task => task.id === response.candidateKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH"); break;
    case "accept_understanding":
    case "keep_unknown":
      if (response.versionKey !== workspace.currentVersionId) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH"); break;
    case "choose_positioning":
      if (!gate.choices.some(choice => choice.key === response.choiceKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH"); break;
    case "apply_story": case "keep_story": case "retry_story":
      if (!gate.choices.some(choice => choice.key === response.candidateKey)) failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH"); break;
    case "feedback": case "exact_edit_story":
      if (response.observedCheckpointHash !== gate.checkpointHash) failEvidence("WORKFLOW_FEEDBACK_OBSERVATION_MISMATCH"); break;
    case "not_needed": case "edit_positioning": case "undo_positioning": case "review_positioning": case "undo_story": case "restore_story": case "edit_deck_page": case "record_review": case "record_use": case "use_not_observed": case "stop": break;
    default: { const exhaustive: never = response; return exhaustive; }
  }
  humanEffect(gate.step, workspace, response, "validation-only");
}
type AutomaticEffect = { kind: "operation"; key: string; command: z.infer<typeof workspaceCommandSchema>; nextStep: Step } | { kind: "framing_available" };
function automaticEffect(input: { context: Context; step: Step; workspace: Workspace; completed: Iterable<CompletedOperation>; decisions: Iterable<Decision>; resolved: Set<string> }): AutomaticEffect {
  const { context, step, workspace } = input, normalInput = previewTaskModelInput(context.state.bundle);
  const done = [...input.completed];
  const positioning = workspace.positioning ? readPositioning(workspace.positioning) : null;
  const head = workspace.story?.head ?? { generation: 0, storyId: null };
  let key: string, command: object, nextStep: Step;
  switch (step) {
    case "materials": {
      const keys = new Set(done.map(item => item.operation.operationKey));
      const source = normalInput.sources.find(item => !keys.has(`import:${item.id}`));
      if (source) {
        key = `import:${source.id}`; command = { action: "add_material", name: `${source.id}.md`, mediaType: "text/markdown", text: `Source: ${source.id}\nAuthority: ${source.authority}\nURL: ${source.url}\n\n${source.material}\n\nBoundary: ${source.boundary}` }; nextStep = "materials";
      } else { key = "task-context"; command = { action: "save_brief", expectedVersionId: null, text: JSON.stringify(normalInput.task) }; nextStep = "understanding"; }
      break;
    }
    case "understanding": key = "understanding:first"; command = { action: "run" }; nextStep = "understanding_review"; break;
    case "positioning":
      if (workspace.project.phase !== "accepted" || !workspace.currentVersionId) failEvidence("WORKFLOW_ACCEPTED_UNDERSTANDING_REQUIRED");
      key = `positioning:${workspace.currentVersionId}:${hashTaskValue(positioning?.head ?? null)}`;
      command = { action: "generate_positioning", expectedRevision: workspace.project.revision, expectedPositioning: positioning?.head ?? { positioningId: null, decisionId: null } }; nextStep = "positioning_wording"; break;
    case "positioning_wording":
      if (!positioning) failEvidence("WORKFLOW_POSITIONING_REQUIRED");
      if (positioning.choices.some(choice => choice.kind === "manual_exact" && choice.text === normalInput.task.originalFraming)) return { kind: "framing_available" };
      key = `case-framing:${positioning.head.positioningId}`;
      command = { action: "save_positioning_wording", expectedRevision: workspace.project.revision, expectedPositioning: positioning.head, wording: { kind: "manual_exact", text: normalInput.task.originalFraming } }; nextStep = "positioning_choice"; break;
    case "story_initial":
      if (!positioning?.applied) failEvidence("WORKFLOW_ADOPTED_POSITIONING_REQUIRED");
      key = `initial-story:${hashTaskValue({ positioning: positioning.head, story: head })}`;
      command = { action: "propose_story", expected: head, request: { kind: "develop_direction" } }; nextStep = "story_initial_candidate"; break;
    case "story_revision": {
      const feedback = [...input.decisions].filter(item => item.response.kind === "feedback" && input.resolved.has(item.decisionId)).at(-1);
      if (!feedback || feedback.response.kind !== "feedback" || feedback.response.storyKey !== head.storyId) failEvidence("WORKFLOW_FROZEN_FEEDBACK_REQUIRED");
      key = `revision:${feedback.decisionId}`;
      // Only the actual original feedback enters the product request; oracle/expectations stay local.
      command = { action: "propose_story", expected: head, request: { kind: "revise_story", judgment: feedback.response.originalWords } }; nextStep = "story_revision_candidate"; break;
    }
    case "deck":
      if (!head.storyId || workspace.story?.stale || !workspace.story?.versions.some(item => item.id === head.storyId)) failEvidence("WORKFLOW_FRESH_ADOPTED_STORY_REQUIRED");
      key = `deck:${head.storyId}:${head.generation}`; command = { action: "create_story_deck", expected: head }; nextStep = "deck_review"; break;
    default: failEvidence("WORKFLOW_AUTOMATIC_EFFECT_NOT_ALLOWED");
  }
  return { kind: "operation", key, command: workspaceCommandSchema.parse({ ...command, commandId: operationIdFor(context, key) }), nextStep };
}
function gateSpecification(input: { context: Context; step: Step; workspace: Workspace; completed: Iterable<CompletedOperation> }) {
  const { context, step, workspace } = input;
  const choices: z.infer<typeof gateSchema>["choices"] = [];
  let allowedActions: string[];
  switch (step) {
    case "understanding_review": {
      const version = workspace.versions.find(item => item.id === workspace.currentVersionId);
      if (!version || workspace.project.phase !== "review_required") failEvidence("WORKFLOW_UNDERSTANDING_NOT_REVIEWABLE");
      for (const task of version.proposal.topicTasks ?? []) choices.push({ key: task.id, text: task.question.question, provenance: "Actual product question; answering every question is not required" });
      if (!choices.length) choices.push({ key: "next-question", text: version.proposal.nextQuestion.question, provenance: "Actual current product question" });
      allowedActions = ["answer_clarification", "keep_unknown", "not_needed", "stop"]; break;
    }
    case "understanding_accept": {
      const version = workspace.versions.find(item => item.id === workspace.currentVersionId);
      if (!version || workspace.project.phase !== "review_required") failEvidence("WORKFLOW_UNDERSTANDING_NOT_REVIEWABLE");
      choices.push({ key: version.id, text: `Understanding ${version.number}`, provenance: "Actual review version; Apply has not accepted it" });
      allowedActions = ["accept_understanding", "stop"]; break;
    }
    case "clarification_wait": {
      const submitted = [...input.completed].filter(item => item.operation.command.action === "submit_clarification").at(-1);
      const task = workspace.clarifications?.find(item => item.commandId === submitted?.operation.command.commandId);
      if (!task || !["proposal_ready", "no_change"].includes(task.status)) failEvidence("WORKFLOW_CLARIFICATION_NOT_REVIEWABLE");
      choices.push({ key: task.id, text: JSON.stringify(task.result ?? { status: task.status }), provenance: "Actual Clarification output; not automatically adopted" });
      allowedActions = task.status === "proposal_ready" ? ["apply_clarification", "dismiss_clarification", "stop"] : ["dismiss_clarification", "stop"]; break;
    }
    case "positioning_choice": {
      if (!workspace.positioning) failEvidence("WORKFLOW_POSITIONING_REQUIRED");
      const value = readPositioning(workspace.positioning);
      for (const choice of value.choices) choices.push({ key: choice.id, text: choice.text, provenance: choice.kind === "manual_exact" && choice.text === context.state.bundle.taskCase.spec.originalFraming ? "Frozen case wording · manual exact input, unverified; not a client quote" : choice.kind });
      allowedActions = ["choose_positioning", "edit_positioning", ...(value.canUndo ? ["undo_positioning"] : []), "stop"]; break;
    }
    case "story_initial_candidate":
    case "story_revision_candidate": {
      const generated = [...input.completed].filter(item => item.operation.nextStep === step && item.operation.command.action === "propose_story").at(-1);
      const proposal = workspace.story?.proposals.find(item => item.commandId === generated?.operation.command.commandId);
      if (!proposal || !["ready", "no_change"].includes(proposal.state.kind)) failEvidence("WORKFLOW_STORY_NOT_REVIEWABLE");
      choices.push({ key: proposal.id, text: JSON.stringify(proposal.state), provenance: "Actual saved Story candidate; saved version is not adoption" });
      allowedActions = [...(proposal.state.kind === "ready" ? ["apply_story"] : []), "keep_story", "retry_story", "stop"]; break;
    }
    case "feedback": {
      const adopted = workspace.story?.versions.find(item => item.id === workspace.story?.head.storyId);
      if (adopted) choices.push({ key: adopted.id, text: JSON.stringify(adopted.story), provenance: "Actual adopted Story: observe this before freezing feedback" });
      for (const version of workspace.story?.versions ?? []) if (version.id !== adopted?.id) choices.push({ key: version.id, text: JSON.stringify(version.story), provenance: "Saved historical Story; it may never have been adopted. Restore is a proposal." });
      allowedActions = adopted ? ["feedback", "exact_edit_story", "not_needed", "undo_story", "restore_story", "review_positioning", "stop"] : ["restore_story", "review_positioning", "stop"]; break;
    }
    case "deck_review":
      if (!workspace.deck || workspace.deck.proposal.schemaVersion !== 2) failEvidence("WORKFLOW_STORY_DECK_REQUIRED");
      for (const page of workspace.deck.proposal.pages) choices.push({ key: page.id, text: JSON.stringify(page), provenance: "Actual saved Deck V2 page; manual edits need their own review" });
      allowedActions = ["record_review", "edit_deck_page", "undo_story", "review_positioning", "stop"]; break;
    case "actual_use":
      allowedActions = ["record_use", "use_not_observed", "stop"]; break;
    default: failEvidence("WORKFLOW_HUMAN_GATE_NOT_ALLOWED");
  }
  return { choices, allowedActions };
}
function verifyProductEffect(operation: Operation, before: Workspace, after: Workspace) {
  const command = operation.command;
  const require = (condition: boolean, reason: string) => { if (!condition) failEvidence(reason); };
  const oldHead = before.story?.head ?? { storyId: null, generation: 0 };
  const newHead = after.story?.head ?? { storyId: null, generation: 0 };
  switch (command.action) {
    case "add_material":
      require(after.sources.some(item => item.kind === "file" && item.name === command.name && item.content === normalizeMaterialText(command.text)), "WORKFLOW_IMPORT_CONTENT_MISMATCH");
      require(after.sources.length === before.sources.length + 1, "WORKFLOW_IMPORT_COUNT_MISMATCH"); break;
    case "save_brief":
      require(after.brief.head?.entry.kind === "saved" && after.brief.head.entry.text === normalizeMaterialText(command.text), "WORKFLOW_CONTEXT_CONTENT_MISMATCH"); break;
    case "run":
      require(after.project.phase === "review_required" && Boolean(after.currentVersionId) && after.currentVersionId !== before.currentVersionId, "WORKFLOW_UNDERSTANDING_RESULT_MISMATCH"); break;
    case "submit_clarification":
      require(Boolean(after.clarifications?.some(task => task.commandId === command.commandId && task.answer === command.text && task.baseRevision === command.expectedRevision)), "WORKFLOW_CLARIFICATION_SUBMISSION_MISMATCH");
      require(after.currentVersionId === before.currentVersionId, "WORKFLOW_SILENT_UNDERSTANDING_ADOPTION"); break;
    case "apply_clarification": {
      const task = after.clarifications?.find(item => item.id === command.taskId);
      require(task?.status === "applied" && Boolean(task.resultVersionId) && task.resultVersionId === after.currentVersionId && after.currentVersionId !== before.currentVersionId && after.project.phase === "review_required", "WORKFLOW_CLARIFICATION_APPLY_MISMATCH"); break;
    }
    case "dismiss_clarification":
      require(Boolean(after.clarifications?.some(task => task.id === command.taskId && task.status === "dismissed")) && after.currentVersionId === before.currentVersionId, "WORKFLOW_CLARIFICATION_DISMISS_MISMATCH"); break;
    case "keep_unknown":
      require(Boolean(after.currentVersionId) && after.currentVersionId !== before.currentVersionId && after.project.phase === "review_required", "WORKFLOW_KEEP_UNKNOWN_MISMATCH"); break;
    case "accept":
      require(after.project.phase === "accepted" && after.currentVersionId === before.currentVersionId, "WORKFLOW_ACCEPT_VERSION_MISMATCH"); break;
    case "generate_positioning":
      require(Boolean(after.positioning) && after.positioning?.id !== before.positioning?.id && after.positioning?.proposal.understandingVersionId === before.currentVersionId, "WORKFLOW_POSITIONING_RESULT_MISMATCH");
      require(Boolean(after.positioning && readPositioning(after.positioning).applied === null), "WORKFLOW_SILENT_POSITIONING_ADOPTION"); break;
    case "save_positioning_wording":
      require(Boolean(after.positioning && readPositioning(after.positioning).choices.some(choice => choice.kind === command.wording.kind && choice.text === command.wording.text)), "WORKFLOW_CASE_WORDING_MISMATCH");
      require((before.positioning ? readPositioning(before.positioning).applied?.choice.id : null) === (after.positioning ? readPositioning(after.positioning).applied?.choice.id : null), "WORKFLOW_SILENT_POSITIONING_ADOPTION"); break;
    case "apply_positioning":
      require(Boolean(after.positioning && readPositioning(after.positioning).applied?.choice.id === command.directionId), "WORKFLOW_POSITIONING_CHOICE_MISMATCH");
      require(hashTaskValue(oldHead) === hashTaskValue(newHead), "WORKFLOW_SILENT_STORY_ADOPTION"); break;
    case "adjust_positioning": {
      const direction = after.positioning?.proposal.directions.find(item => item.id === command.directionId);
      require(Boolean(direction && (command.mode === "headline" ? direction.coreMessage : direction.judgmentNote) === command.text), "WORKFLOW_POSITIONING_EDIT_MISMATCH"); break;
    }
    case "undo_positioning": {
      const prior = before.positioning?.proposal.decisionJournal?.at(-1)?.before?.choice.id ?? null;
      const actual = after.positioning ? readPositioning(after.positioning).applied?.choice.id ?? null : null;
      require(actual === prior, "WORKFLOW_POSITIONING_UNDO_MISMATCH"); break;
    }
    case "propose_story": {
      const proposal = after.story?.proposals.find(item => item.commandId === command.commandId);
      require(Boolean(proposal && hashTaskValue(proposal.baseHead) === hashTaskValue(command.expected) && hashTaskValue(proposal.snapshot.request) === hashTaskValue(command.request)), "WORKFLOW_STORY_PROPOSAL_MISMATCH");
      require(hashTaskValue(oldHead) === hashTaskValue(newHead), "WORKFLOW_SILENT_STORY_ADOPTION"); break;
    }
    case "decide_story": {
      const original = before.story?.proposals.find(item => item.id === command.proposalId);
      const applied = after.story?.proposals.find(item => item.id === command.proposalId);
      if (command.decision === "apply") {
        if (!original || original.state.kind !== "ready") failEvidence("WORKFLOW_STORY_CANDIDATE_MISSING");
        const adopted = after.story?.versions.find(item => item.id === newHead.storyId);
        require(newHead.storyId === original.state.candidateId && newHead.generation === oldHead.generation + 1 && Boolean(adopted && hashTaskValue(adopted.story) === hashTaskValue(original.state.candidate)), "WORKFLOW_STORY_ADOPTED_CONTENT_MISMATCH");
      } else require(hashTaskValue(oldHead) === hashTaskValue(newHead), "WORKFLOW_KEEP_REPLACED_STORY");
      require(Boolean(applied && (applied.state.kind === "applied" || applied.state.kind === "kept") && applied.state.commandId === command.commandId), "WORKFLOW_STORY_DECISION_RECEIPT_MISMATCH"); break;
    }
    case "undo_story": {
      const adopted = before.story?.versions.find(item => item.id === oldHead.storyId);
      require(Boolean(adopted) && newHead.storyId === adopted?.parentId && newHead.generation === oldHead.generation + 1, "WORKFLOW_STORY_UNDO_MISMATCH"); break;
    }
    case "create_story_deck": {
      const adopted = before.story?.versions.find(item => item.id === oldHead.storyId);
      if (!adopted || !oldHead.storyId) failEvidence("WORKFLOW_ADOPTED_STORY_REQUIRED");
      const expected = storyToDeck({ storyId: oldHead.storyId, generation: oldHead.generation, story: adopted.story });
      require(Boolean(after.deck && after.deck.proposal.schemaVersion === 2 && hashTaskValue(after.deck.proposal) === hashTaskValue(expected)), "WORKFLOW_DECK_STORY_TRANSFER_MISMATCH"); break;
    }
    case "edit_deck_page": {
      const page = after.deck?.proposal.pages.find(item => item.id === command.pageId);
      require(Boolean(page && page.title === command.title && page.body === command.body && after.deck && before.deck && after.deck.number === before.deck.number + 1), "WORKFLOW_DECK_MANUAL_EDIT_MISMATCH");
      require(Boolean(before.deck && after.deckVersions.some(item => item.id === before.deck?.id && hashTaskValue(item.proposal) === hashTaskValue(before.deck.proposal))), "WORKFLOW_DECK_HISTORY_MISSING"); break;
    }
    default: failEvidence("WORKFLOW_UNSUPPORTED_PRODUCT_EFFECT");
  }
}
function isEmptyInitialWorkspace(workspace: Workspace) {
  return workspace.project.phase === "empty" && !workspace.sources.length && !workspace.versions.length && !workspace.positioning && !workspace.story?.versions.length && !workspace.deck && !workspace.brief.head;
}
function replay(context: Context) {
  let step: Step = "materials", lastCheckpoint: z.infer<typeof sha256Schema> | null = null;
  let pending: Operation | null = null, gate: z.infer<typeof gateSchema> | null = null, held: string | null = null;
  let pendingDecision: Decision | null = null;
  const decisionSteps = new Map<string, Step>();
  const decisions = new Map<string, Decision>(), resolvedDecisions = new Set<string>(), rejectedDecisions = new Map<string, Decision>();
  const completed = new Map<string, { operation: Operation; checkpointHash: z.infer<typeof sha256Schema> }>();
  for (const fact of context.facts) {
    switch (fact.kind) {
      case "workflow_started": break;
      case "workflow_snapshot": {
        const observed = snapshot(context, fact.checkpointHash);
        if (!lastCheckpoint && !isEmptyInitialWorkspace(observed.workspace)) failEvidence("WORKFLOW_INITIAL_SNAPSHOT_NOT_EMPTY");
        lastCheckpoint = fact.checkpointHash; break;
      }
      case "workflow_gate": {
        if (pending || held || fact.step !== step || fact.caseBindingHash !== hashTaskValue(context.state.bundle.binding)) failEvidence("WORKFLOW_INVALID_GATE_ORDER");
        if (snapshot(context, fact.checkpointHash).workspaceHash !== fact.workspaceHash) failEvidence("WORKFLOW_GATE_CONTENT_MISMATCH");
        const { capability, ...body } = fact;
        if (hashTaskValue(body) !== capability) failEvidence("WORKFLOW_GATE_CAPABILITY_MISMATCH");
        const expected = gateSpecification({ context, step, workspace: snapshot(context, fact.checkpointHash).workspace, completed: completed.values() });
        if (hashTaskValue(expected.choices) !== hashTaskValue(fact.choices) || hashTaskValue(expected.allowedActions) !== hashTaskValue(fact.allowedActions)) failEvidence("WORKFLOW_GATE_POLICY_MISMATCH");
        gate = fact; break;
      }
      case "workflow_operation": {
        if (pending || held || fact.fromStep !== step || completed.has(fact.operationId)) failEvidence("WORKFLOW_INVALID_OPERATION_ORDER");
        if (fact.checkpointHash !== lastCheckpoint || fact.operationId !== operationIdFor(context, fact.operationKey) || fact.command.commandId !== fact.operationId || fact.stage !== stageForStep[fact.fromStep]) failEvidence("WORKFLOW_OPERATION_BINDING_MISMATCH");
        if ((pendingDecision?.decisionId ?? null) !== fact.decisionId) failEvidence("WORKFLOW_OPERATION_DECISION_MISMATCH");
        if (pendingDecision) {
          const origin = decisionSteps.get(pendingDecision.decisionId); if (!origin) failEvidence("WORKFLOW_DECISION_ORIGIN_MISSING");
          const effect = humanEffect(origin, snapshot(context, pendingDecision.checkpointHash).workspace, pendingDecision.response, fact.operationId);
          if (!effect.command || effect.nextStep !== fact.nextStep || fact.operationKey !== `decision:${pendingDecision.decisionId}` || hashTaskValue(effect.command) !== hashTaskValue(fact.command)) failEvidence("WORKFLOW_HUMAN_EFFECT_MISMATCH");
        } else {
          const effect = automaticEffect({ context, step, workspace: snapshot(context, fact.checkpointHash).workspace, completed: completed.values(), decisions: decisions.values(), resolved: resolvedDecisions });
          if (effect.kind !== "operation" || effect.key !== fact.operationKey || effect.nextStep !== fact.nextStep || hashTaskValue(effect.command) !== hashTaskValue(fact.command)) failEvidence("WORKFLOW_AUTOMATIC_EFFECT_MISMATCH");
        }
        snapshot(context, fact.checkpointHash); pending = fact; gate = null; break;
      }
      case "workflow_takeover": {
        const current = pendingOperation(pending, fact.operationId);
        if (current.owner.token !== fact.previousToken) failEvidence("WORKFLOW_INVALID_TAKEOVER");
        pending = { ...current, owner: fact.owner }; break;
      }
      case "workflow_operation_done": {
        const current = pendingOperation(pending, fact.operationId);
        const receipt = inspectWorkspaceReceipt({ state: context.state, binding: context.locator.launchReceipt, commandId: current.command.commandId ?? "" });
        if (receipt.kind !== "outcome" || (receipt.outcome.kind !== "confirmed" && receipt.outcome.kind !== "recovered") || receipt.outcomeHash !== fact.receiptHash || receipt.prepared.attemptId !== current.operationId || receipt.prepared.requestBodyHash !== hashTaskBytes(JSON.stringify(current.command))) failEvidence("WORKFLOW_COMPLETION_RECEIPT_MISMATCH");
        if (snapshot(context, fact.checkpointHash).workspaceHash !== hashTaskValue(receipt.outcome.state)) failEvidence("WORKFLOW_COMPLETION_CONTENT_MISMATCH");
        verifyProductEffect(current, snapshot(context, current.checkpointHash).workspace, receipt.outcome.state);
        const at = context.state.observations.findIndex(item => item.id === `workflow:done:${fact.operationId}` && hashTaskValue(item.data) === hashTaskValue(fact));
        const receiptAt = context.state.observations.findIndex(item => item.id === `workspace:${current.command.commandId}:outcome`);
        if (at <= receiptAt || receiptAt < 0) failEvidence("WORKFLOW_COMPLETION_RECEIPT_ORDER");
        completed.set(fact.operationId, { operation: current, checkpointHash: fact.checkpointHash });
        step = current.nextStep; lastCheckpoint = fact.checkpointHash; pending = null; gate = null; break;
      }
      case "workflow_held": held = fact.reason; gate = null; break;
      case "workflow_decision":
        if (held || pending || pendingDecision || !gate || decisions.has(fact.decision.decisionId) || rejectedDecisions.has(fact.decision.decisionId) || gate.checkpointHash !== fact.decision.checkpointHash || gate.capability !== fact.decision.capability || !gate.allowedActions.includes(fact.decision.response.kind)) failEvidence("WORKFLOW_INVALID_DECISION_ORDER");
        validateTarget(gate, fact.decision, snapshot(context, gate.checkpointHash).workspace);
        decisions.set(fact.decision.decisionId, fact.decision); decisionSteps.set(fact.decision.decisionId, step); pendingDecision = fact.decision; gate = null; break;
      case "workflow_decision_resolved": {
        if (!pendingDecision || pending || pendingDecision.decisionId !== fact.decisionId) failEvidence("WORKFLOW_DECISION_RESOLUTION_ORDER");
        const origin = decisionSteps.get(fact.decisionId); if (!origin) failEvidence("WORKFLOW_DECISION_ORIGIN_MISSING");
        const expectedId = operationIdFor(context, `decision:${fact.decisionId}`);
        const effect = humanEffect(origin, snapshot(context, pendingDecision.checkpointHash).workspace, pendingDecision.response, expectedId);
        if (fact.nextStep !== effect.nextStep || (effect.command !== null && !completed.has(expectedId))) failEvidence("WORKFLOW_DECISION_RESOLUTION_EFFECT_MISMATCH");
        resolvedDecisions.add(fact.decisionId); pendingDecision = null; step = fact.nextStep; gate = null; break;
      }
      case "workflow_decision_rejected":
        if (decisions.has(fact.decision.decisionId) || rejectedDecisions.has(fact.decision.decisionId)) failEvidence("WORKFLOW_DECISION_ID_REUSED");
        rejectedDecisions.set(fact.decision.decisionId, fact.decision); if (fact.reason === "WORKFLOW_PRODUCT_CHANGED") gate = null; break;
      case "workflow_framing_available":
        if (pending || pendingDecision || held || step !== "positioning_wording" || fact.checkpointHash !== lastCheckpoint) failEvidence("WORKFLOW_FRAMING_OBSERVATION_ORDER");
        if (automaticEffect({ context, step, workspace: snapshot(context, fact.checkpointHash).workspace, completed: completed.values(), decisions: decisions.values(), resolved: resolvedDecisions }).kind !== "framing_available") failEvidence("WORKFLOW_CASE_FRAMING_MISSING");
        step = "positioning_choice"; gate = null; break;
      default: { const exhaustive: never = fact; return exhaustive; }
    }
  }
  return { step, lastCheckpoint, pending, gate, held, completed, pendingDecision, decisions, resolvedDecisions, rejectedDecisions };
}
function appendFact(context: Context, id: string, fact: WorkflowFact, step: Step) {
  const prior = context.state.observations.find(item => item.id === id);
  if (prior && hashTaskValue(prior.data) !== hashTaskValue(fact)) failEvidence("WORKFLOW_FACT_ID_CONFLICT");
  const reference = appendTaskObservation(context.policy, context.state.reference, {
    id, at: prior?.at ?? new Date().toISOString(), stage: stageForStep[step], attemptId: null, commandId: null, checkpointHash: null,
    kind: "observation", data: fact,
  });
  saveAnchor(context.policy, reference);
  Object.assign(context, loadRun(context.run));
}
function client(context: Context) { return new IsolatedWorkspaceClient({ binding: context.locator.launchReceipt, policy: context.policy, reference: context.state.reference }); }
function assertCodeUnchanged(context: Context) {
  const original = context.state.manifest.identity.source;
  const current = captureTaskSourceIdentity(context.locator.sourceRepository, original.files.map(item => item.path));
  if (current.head !== original.head || hashTaskValue(current.files) !== hashTaskValue(original.files)) failEvidence("WORKFLOW_CODE_CHANGED");
}
function capture(context: Context, read: { state: Workspace; bodyHash: string }, step: Step, operation: Operation | null) {
  const current = replay(context), workspaceHash = hashTaskValue(read.state);
  if (current.lastCheckpoint && snapshot(context, current.lastCheckpoint).workspaceHash === workspaceHash) return current.lastCheckpoint;
  const attemptId = `workflow-read:${hashTaskValue({ workspaceHash, step, operationId: operation?.operationId ?? null })}`;
  const prior = context.state.checkpoints.get(attemptId);
  const time = new Date().toISOString();
  const input = prior?.value.input ?? {
    stage: stageForStep[step], attemptId, commandId: operation?.command.commandId ?? `read-${workspaceHash}`, projectId: read.state.project.id, revision: read.state.project.revision,
    startedAt: time, endedAt: time, parentCheckpointHashes: current.lastCheckpoint ? [current.lastCheckpoint] : [],
    versionIds: { understanding: read.state.currentVersionId ?? null, positioning: read.state.positioning?.id ?? null, story: read.state.story?.head.storyId ?? null, deck: read.state.deck?.id ?? null },
    model: "not_applicable_http_readback", promptVersion: "workspace-readback-v1", runtime: context.state.manifest.identity.runtime,
    usage: { kind: "unknown", reason: "Workspace readback does not expose complete model usage." },
    request: { kind: "workspace_readback", operationId: operation?.operationId ?? null }, response: { kind: "transport_summary", status: "received", httpStatus: 200, providerStatus: null, observedModel: null },
    originalBodyDigests: { request: { kind: "unknown", reason: "No GET request body." }, response: { kind: "known", sha256: read.bodyHash, scope: "body_bytes_before_projection", evidenceRef: "isolated workspace HTTP readback" } },
    result: { kind: "unverified_record", data: { kind: "workflow_workspace", workspace: read.state, workspaceHash } },
  };
  const saved = appendTaskCheckpoint(context.policy, context.state.reference, input);
  saveAnchor(context.policy, saved.reference); Object.assign(context, loadRun(context.run));
  appendFact(context, `workflow:snapshot:${saved.checkpointHash}`, { kind: "workflow_snapshot", checkpointHash: saved.checkpointHash }, step);
  return saved.checkpointHash;
}
function held(context: Context, reason: string, operation: Operation | null): Held {
  appendFact(context, `workflow:held:${hashTaskValue({ reason, operationId: operation?.operationId ?? null })}`, { kind: "workflow_held", reason, operationId: operation?.operationId ?? null }, replay(context).step);
  return { kind: "held", reason, step: replay(context).step };
}
function fresh(context: Context, state: Workspace) {
  const flow = replay(context);
  if (flow.lastCheckpoint && snapshot(context, flow.lastCheckpoint).workspaceHash !== hashTaskValue(state)) failEvidence("WORKFLOW_PRODUCT_CHANGED");
}
async function executeOperation(context: Context, operation: Operation, newlyClaimed: boolean): Promise<OperationProgress> {
  if (!newlyClaimed) {
    if (operation.owner.host !== hostname()) return held(context, "WORKFLOW_OWNER_UNVERIFIABLE", operation);
    try { process.kill(operation.owner.pid, 0); return { kind: "held", reason: "WORKFLOW_OWNER_LIVE", step: operation.fromStep }; }
    catch (error) {
      const code = z.object({ code: z.string() }).safeParse(error).data?.code;
      if (code !== "ESRCH") return held(context, "WORKFLOW_OWNER_UNVERIFIABLE", operation);
    }
    const owner = { host: hostname(), pid: process.pid, token: randomUUID() };
    appendFact(context, `workflow:takeover:${operation.operationId}:${owner.token}`, { kind: "workflow_takeover", operationId: operation.operationId, previousToken: operation.owner.token, owner }, operation.fromStep);
    operation = { ...operation, owner };
  }
  const transport = client(context);
  const prepared = context.state.observations.some(item => item.id === `workspace:${operation.command.commandId}:prepared`);
  if (!prepared) fresh(context, (await transport.read()).state);
  const outcome = await transport.execute({ attemptId: operation.operationId, stage: operation.stage, expectedRevision: snapshot(context, operation.checkpointHash).workspace.project.revision, command: operation.command });
  saveAnchor(context.policy, transport.reference); Object.assign(context, loadRun(context.run));
  if (outcome.kind === "conflict" || outcome.kind === "outcome_unknown") return held(context, outcome.kind === "conflict" ? "WORKFLOW_PRODUCT_CONFLICT" : "WORKFLOW_OUTCOME_UNKNOWN", operation);
  const after = capture(context, { state: outcome.state, bodyHash: outcome.responseBodyHash }, operation.nextStep, operation);
  try { verifyProductEffect(operation, snapshot(context, operation.checkpointHash).workspace, outcome.state); }
  catch (error) { return held(context, errorCode(error) ?? "WORKFLOW_PRODUCT_EFFECT_MISMATCH", operation); }
  const receipt = inspectWorkspaceReceipt({ state: context.state, binding: context.locator.launchReceipt, commandId: operation.command.commandId ?? "" });
  if (receipt.kind !== "outcome") failEvidence("WORKFLOW_COMPLETION_RECEIPT_MISSING");
  appendFact(context, `workflow:done:${operation.operationId}`, { kind: "workflow_operation_done", operationId: operation.operationId, checkpointHash: after, receiptHash: sha256Schema.parse(receipt.outcomeHash) }, operation.nextStep);
  return { kind: "operation_completed" };
}
async function dispatch(context: Context, input: { key: string; command: unknown; nextStep: Step; decisionId?: string }) {
  const flow = replay(context); if (!flow.lastCheckpoint) failEvidence("WORKFLOW_CHECKPOINT_MISSING");
  const operationId = operationIdFor(context, input.key);
  const command = workspaceCommandSchema.parse({ ...z.record(z.string(), z.unknown()).parse(input.command), commandId: operationId });
  const operation = operationSchema.parse({ kind: "workflow_operation", operationId, operationKey: input.key, owner: { host: hostname(), pid: process.pid, token: randomUUID() }, fromStep: flow.step, nextStep: input.nextStep, checkpointHash: flow.lastCheckpoint, stage: stageForStep[flow.step], command, decisionId: input.decisionId ?? null });
  appendFact(context, `workflow:claim:${operationId}`, operation, flow.step);
  return executeOperation(context, operation, true);
}

function gateView(context: Context, step: Step, choices: z.infer<typeof gateSchema>["choices"], allowedActions: string[]): HumanBoundary {
  const flow = replay(context); if (!flow.lastCheckpoint) failEvidence("WORKFLOW_CHECKPOINT_MISSING");
  const observed = snapshot(context, flow.lastCheckpoint);
  const body = { kind: "workflow_gate", step, checkpointHash: flow.lastCheckpoint, caseBindingHash: hashTaskValue(context.state.bundle.binding), workspaceHash: observed.workspaceHash, choices, allowedActions };
  const gate = gateSchema.parse({ ...body, capability: hashTaskValue(body) });
  if (!flow.gate || flow.gate.capability !== gate.capability) appendFact(context, `workflow:gate:${gate.capability}`, gate, step);
  return { kind: "awaiting_human", checkpointHash: gate.checkpointHash, capability: gate.capability, step, choices: structuredClone(choices), allowedActions: [...allowedActions], workspace: structuredClone(observed.workspace) };
}

/** Automatic work stops at a human boundary; it never performs Apply or Accept. */
export async function advance(raw: unknown): Promise<TaskWorkflowProgress> {
  const context = loadRun(raw); assertCodeUnchanged(context);
  const modelInput = previewTaskModelInput(context.state.bundle);
  for (let count = 0; count < modelInput.sources.length + 5; count++) {
    const flow = replay(context);
    if (flow.held) return { kind: "held", reason: flow.held, step: flow.step };
    if (flow.step === "stopped" || flow.step === "finished") return { kind: flow.step, reference: context.state.reference };
    if (flow.pendingDecision) return { kind: "resume_decision", decisionId: flow.pendingDecision.decisionId };
    if (flow.pending) { const result = await executeOperation(context, flow.pending, false); if (result.kind !== "operation_completed") return result; continue; }
    const read = await client(context).read();
    if (!flow.lastCheckpoint) {
      if (!isEmptyInitialWorkspace(read.state)) return held(context, "WORKFLOW_REQUIRES_EMPTY_OWNED_PROJECT", null);
      capture(context, read, "materials", null);
    } else if (flow.step !== "clarification_wait") fresh(context, read.state);
    switch (flow.step) {
      case "materials": case "understanding": case "positioning": case "positioning_wording": case "story_initial": case "story_revision": case "deck": {
        const effect = automaticEffect({ context, step: flow.step, workspace: read.state, completed: flow.completed.values(), decisions: flow.decisions.values(), resolved: flow.resolvedDecisions });
        if (effect.kind === "framing_available") {
          const checkpoint = replay(context).lastCheckpoint; if (!checkpoint) failEvidence("WORKFLOW_CHECKPOINT_MISSING");
          appendFact(context, `workflow:framing:${checkpoint}`, { kind: "workflow_framing_available", checkpointHash: checkpoint }, flow.step);
        } else await dispatch(context, { key: effect.key, command: effect.command, nextStep: effect.nextStep });
        break;
      }
      case "clarification_wait": {
        const submitted = [...flow.completed.values()].filter(item => item.operation.command.action === "submit_clarification").at(-1);
        if (!submitted) failEvidence("WORKFLOW_CLARIFICATION_SUBMISSION_MISSING");
        const baseline = snapshot(context, submitted.checkpointHash).workspace;
        const withoutAsync = ({ clarifications: _tasks, events: _events, workflowRuns: _runs, ...rest }: Workspace) => rest;
        if (hashTaskValue(withoutAsync(baseline)) !== hashTaskValue(withoutAsync(read.state))) return held(context, "WORKFLOW_CLARIFICATION_BASE_CHANGED", null);
        const task = read.state.clarifications?.find(item => item.commandId === submitted.operation.command.commandId);
        if (!task) return held(context, "WORKFLOW_CLARIFICATION_TASK_MISSING", null);
        capture(context, read, "clarification_wait", null);
        if (task.status === "queued" || task.status === "running") return { kind: "awaiting_product", taskId: task.id, status: task.status };
        if (task.status === "failed" || task.status === "stale") return held(context, "WORKFLOW_CLARIFICATION_FAILED_OR_STALE", null);
        const spec = gateSpecification({ context, step: flow.step, workspace: read.state, completed: flow.completed.values() });
        return gateView(context, flow.step, spec.choices, spec.allowedActions);
      }
      case "understanding_review": case "understanding_accept": case "positioning_choice": case "story_initial_candidate": case "feedback": case "story_revision_candidate": case "deck_review": case "actual_use": {
        try {
          const spec = gateSpecification({ context, step: flow.step, workspace: read.state, completed: flow.completed.values() });
          return gateView(context, flow.step, spec.choices, spec.allowedActions);
        } catch (error) {
          if (errorCode(error) === "WORKFLOW_STORY_NOT_REVIEWABLE") return held(context, "WORKFLOW_STORY_NOT_REVIEWABLE", null);
          throw error;
        }
      }
      default: return { kind: "held", reason: "WORKFLOW_INVALID_PHASE", step: flow.step };
    }
  }
  return { kind: "held", reason: "WORKFLOW_ADVANCE_BOUND", step: replay(context).step };
}

/** Human effects execute only from the exact displayed checkpoint and explicit original intent. */
export async function recordDecision(raw: unknown): Promise<TaskWorkflowProgress> {
  const input = z.object({ run: runRefSchema, decision: decisionSchema }).strict().parse(raw);
  const context = loadRun(input.run); assertCodeUnchanged(context);
  let flow = replay(context);
  const prior = flow.decisions.get(input.decision.decisionId) ?? flow.rejectedDecisions.get(input.decision.decisionId);
  if (prior && hashTaskValue(prior) !== hashTaskValue(input.decision)) failEvidence("WORKFLOW_DECISION_ID_CONFLICT");
  if (flow.rejectedDecisions.has(input.decision.decisionId)) failEvidence("WORKFLOW_DECISION_REJECTED");
  if (flow.resolvedDecisions.has(input.decision.decisionId)) return { kind: "decision_completed", decisionId: input.decision.decisionId, nextStep: flow.step };
  if (flow.held) return { kind: "held", reason: flow.held, step: flow.step };
  if (!prior) {
    const gate = flow.gate;
    if (!gate || gate.checkpointHash !== input.decision.checkpointHash || gate.capability !== input.decision.capability || !gate.allowedActions.includes(input.decision.response.kind)) failEvidence("WORKFLOW_STALE_OR_DISALLOWED_DECISION");
    try { validateTarget(gate, input.decision, snapshot(context, gate.checkpointHash).workspace); }
    catch {
      appendFact(context, `workflow:rejected:${input.decision.decisionId}`, { kind: "workflow_decision_rejected", decision: input.decision, reason: "WORKFLOW_DECISION_TARGET_MISMATCH" }, gate.step);
      failEvidence("WORKFLOW_DECISION_TARGET_MISMATCH");
    }
    const read = await client(context).read();
    if (hashTaskValue(read.state) !== gate.workspaceHash) {
      capture(context, read, gate.step, null);
      appendFact(context, `workflow:rejected:${input.decision.decisionId}`, { kind: "workflow_decision_rejected", decision: input.decision, reason: "WORKFLOW_PRODUCT_CHANGED" }, gate.step);
      failEvidence("WORKFLOW_STALE_DECISION");
    }
    appendFact(context, `workflow:decision:${input.decision.decisionId}`, { kind: "workflow_decision", decision: input.decision }, gate.step);
    flow = replay(context);
  }
  if (flow.pendingDecision?.decisionId !== input.decision.decisionId) failEvidence("WORKFLOW_OTHER_DECISION_PENDING");
  const response = input.decision.response;
  const completed = [...flow.completed.values()].find(item => item.operation.decisionId === input.decision.decisionId);
  if (completed) {
    appendFact(context, `workflow:decision-done:${input.decision.decisionId}`, { kind: "workflow_decision_resolved", decisionId: input.decision.decisionId, nextStep: completed.operation.nextStep }, flow.step);
    return { kind: "decision_completed", decisionId: input.decision.decisionId, nextStep: completed.operation.nextStep };
  }
  if (flow.pending) {
    const result = await executeOperation(context, flow.pending, false);
    if (result.kind !== "operation_completed") return result;
    return recordDecision(input);
  }
  const observed = snapshot(context, input.decision.checkpointHash).workspace;
  const { command, nextStep } = humanEffect(flow.step, observed, response, operationIdFor(context, `decision:${input.decision.decisionId}`));
  if (command) {
    const result = await dispatch(context, { key: `decision:${input.decision.decisionId}`, decisionId: input.decision.decisionId, command, nextStep });
    if (result.kind !== "operation_completed") return result;
  }
  appendFact(context, `workflow:decision-done:${input.decision.decisionId}`, { kind: "workflow_decision_resolved", decisionId: input.decision.decisionId, nextStep }, nextStep);
  return { kind: "decision_completed", decisionId: input.decision.decisionId, nextStep };
}

/** Local preparation only: no HTTP, provider, environment-file discovery or project reset. */
export function prepare(raw: unknown): TaskWorkflowRun {
  const input = prepareSchema.parse(raw), caseDirectory = realpathSync(input.caseDirectory);
  const policyInput = z.json().parse(readJson(input.accountingPolicyFile));
  const policy = loadEvidencePolicy(policyInput);
  const launchReceipt = z.json().parse(parseWorkspaceBinding(readJson(input.launchReceiptFile)));
  assertUnlinkedPath(join(caseDirectory, "materials.json"));
  const bundle = { taskCase: readJson(join(caseDirectory, "case.json")), oracle: readJson(join(caseDirectory, "oracle.json")), materialPackageText: readFileSync(join(caseDirectory, "materials.json"), "utf8") };
  const parsed = parseTaskBundle(bundle);
  if (parsed.taskCase.status !== "frozen") failEvidence("CASE_NOT_FROZEN");
  const sourceRepository = realpathSync(input.sourceRepository);
  const source = captureTaskSourceIdentity(sourceRepository, [
    "pitchroom-app/packages/evals/src/task-acceptance/workflow.ts",
    "pitchroom-app/packages/evals/src/task-acceptance/cli.ts",
    "pitchroom-app/packages/evals/package.json",
    "pitchroom-app/packages/domain/src/workspace.ts",
    "pitchroom-app/packages/domain/src/story.ts",
    "pitchroom-app/packages/domain/src/positioning.ts",
    "pitchroom-app/packages/domain/src/deck.ts",
    "pitchroom-app/packages/evals/src/task-acceptance/workspace-client.ts",
    "pitchroom-app/packages/evals/src/task-acceptance/session.ts",
    "pitchroom-app/packages/evals/src/task-acceptance/capacity.ts",
    "pitchroom-app/packages/evals/src/task-acceptance/schema.ts",
  ]);
  const initialReference = createTaskSession(policy, {
    sessionId: input.sessionId, purpose: input.purpose, maximumBytes: input.maximumBytes - METADATA_BYTES, bundle,
    identity: { source, runtime: {
      web: { kind: "unknown", reason: "Operator launch receipt will be checked by HTTP client; it is not independent build attestation." },
      worker: { kind: "unknown", reason: "No worker build attestation supplied." },
    } },
  });
  // createTaskSession may return an advanced idempotent session; preserve its initialization anchor.
  const existing = verifyTaskSession(policy, initialReference);
  const first = existing.events[0]; if (!first) failEvidence("WORKFLOW_INITIALIZATION_MISSING");
  const initial = taskSessionRefSchema.parse({ ...initialReference, sequence: first.sequence, headHash: first.digest });
  const locator = locatorSchema.parse({ schemaVersion: 1, initialReference: initial, policyInput, launchReceipt, sourceRepository, caseDirectory });
  const data = startedSchema.parse({ kind: "workflow_started", version: 1, configurationHash: hashTaskValue(locator), configuration: locator });
  const prior = existing.observations.find(item => item.id === "workflow:started");
  if (prior && hashTaskValue(prior.data) !== hashTaskValue(data)) failEvidence("WORKFLOW_CONFIGURATION_CHANGED");
  const reference = prior ? existing.reference : appendTaskObservation(policy, existing.reference, {
    id: "workflow:started", at: existing.manifest.createdAt, stage: "materials", attemptId: null, commandId: null, checkpointHash: null,
    kind: "observation", data,
  });
  saveAnchor(policy, reference);
  publishHandle(policy, reference.sessionId, "run.json", locator);
  return { referenceFile: join(handleRoot(policy, reference.sessionId), "run.json") };
}

/** Read-only evidence projection. Execution completion is not semantic or user acceptance. */
export function audit(raw: unknown) {
  const context = loadRun(raw), { state, policy, locator } = context;
  const flow = replay(context);
  const handle = handleRoot(policy, locator.initialReference.sessionId);
  const uncovered = [...flow.decisions.values()].flatMap(decision => decision.response.kind === "not_needed" && flow.resolvedDecisions.has(decision.decisionId)
    ? [{ activity: decision.response.activity, status: "not_covered", reason: decision.response.reason, decisionId: decision.decisionId }]
    : []);
  const useRecords = [...flow.decisions.values()].filter(decision => decision.response.kind === "record_use" && flow.resolvedDecisions.has(decision.decisionId));
  return {
    kind: "workflow_integrity_only", reference: state.reference, purpose: state.manifest.purpose,
    execution: flow.held ? "held" : flow.step === "stopped" || flow.step === "finished" ? flow.step : flow.pendingDecision ? "pending_decision" : flow.gate ? "awaiting_human" : flow.pending ? "pending_operation" : flow.completed.size ? "running" : "prepared", nextStage: flow.step, integrity: "valid", semantic: "not_evaluated", userTask: useRecords.length ? "recorded_awaiting_review" : "not_observed",
    useRecordDecisionIds: useRecords.map(decision => decision.decisionId),
    pendingDecisionId: flow.pendingDecision?.decisionId ?? null, pendingOperationId: flow.pending?.operationId ?? null, uncovered,
    checkpointCount: state.committed.size, uncommittedFiles: state.uncommittedFiles,
    pendingHandleFiles: readdirSync(handle).filter(name => name.startsWith(".pending-")),
    budget: { sessionBytes: state.manifest.maximumBytes, maximumHandleBytes: METADATA_BYTES },
  };
}
export function report(raw: unknown) { return audit(raw); }
