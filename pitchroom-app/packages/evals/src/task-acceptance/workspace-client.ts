import { randomUUID } from "node:crypto";
import { z } from "zod";
import { workspaceCommandSchema, workspaceStateSchema, evaluationInstanceSchema } from "@pitchroom/domain";
import { type EvidencePolicy } from "./capacity";
import { hashTaskBytes, hashTaskValue, taskStageSchema } from "./schema";
import { appendTaskObservation, taskSessionRefSchema, verifyTaskSession, type TaskSessionRef } from "./session";

type Command = z.infer<typeof workspaceCommandSchema>;
type Action = Command["action"];
// GET exposes command identity only for these records. Idempotency is not permission to resend.
export const workspaceRecoveryCapabilities = {
  attach_topic_material: "not_exposed", link_topic_material: "not_exposed", unlink_topic_material: "not_exposed",
  save_brief: "not_exposed", propose_story: "not_exposed", decide_story: "not_exposed",
  undo_story: "not_exposed", create_story_deck: "not_exposed", submit_clarification: "clarification_submission",
  apply_clarification: "not_exposed", dismiss_clarification: "not_exposed", retry_clarification: "not_exposed",
  reset: "forbidden", add_material: "not_exposed", run: "not_exposed", remove_material: "not_exposed",
  correct: "not_exposed", answer: "not_exposed", keep_unknown: "not_exposed", accept: "not_exposed",
  generate_positioning: "not_exposed", apply_positioning: "not_exposed", undo_positioning: "not_exposed",
  adjust_positioning: "not_exposed", save_positioning_wording: "not_exposed", generate_deck: "not_exposed", edit_deck_page: "not_exposed",
} satisfies Record<Action, string>;
const bindingSchema = z.object({
  baseURL: z.string().url().superRefine((raw, context) => {
    const url = new URL(raw);
    if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== "/") context.addIssue({ code: "custom", message: "An explicit numeric loopback HTTP origin and port are required." });
  }),
  instance: evaluationInstanceSchema,
  projectId: z.string().uuid(),
  timeoutMs: z.number().int().min(10).max(120_000),
  maximumResponseBytes: z.number().int().min(1024).max(16_000_000),
}).strict();
export function parseWorkspaceBinding(raw: unknown) { return bindingSchema.parse(raw); }
const preparedSchema = z.object({
  kind: z.literal("workspace_command_prepared"), dispatchOwner: z.string().uuid(), binding: bindingSchema,
  attemptId: z.string().min(1), stage: taskStageSchema, commandId: z.string().min(1),
  request: workspaceCommandSchema, requestBodyHash: z.string(), baselineHash: z.string(), expectedRevision: z.number().int().nonnegative(),
}).strict();
const outcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("confirmed"), state: workspaceStateSchema, responseBodyHash: z.string() }).strict(),
  z.object({ kind: z.literal("recovered"), state: workspaceStateSchema, responseBodyHash: z.string(), proof: z.literal("clarification_submission") }).strict(),
  z.object({ kind: z.literal("conflict"), status: z.literal(409) }).strict(),
  z.object({ kind: z.literal("outcome_unknown"), reason: z.enum(["unconfirmed_mutation", "readback_unavailable"]) }).strict(),
]);
export type WorkspaceCommandOutcome = z.infer<typeof outcomeSchema>;
const terminalSchema = z.object({ kind: z.literal("workspace_command_outcome"), preparedHash: z.string(), outcome: outcomeSchema }).strict();

/** Read-only projection of a PIT-51-verified session; mutation never uses this shortcut. */
export function inspectWorkspaceReceipt(input: { state: ReturnType<typeof verifyTaskSession>; binding: unknown; commandId: string }) {
  const { state, commandId } = input;
  const binding = parseWorkspaceBinding(input.binding);
    const rawPrepared = state.observations.find(item => item.id === `workspace:${commandId}:prepared`);
    const rawOutcome = state.observations.find(item => item.id === `workspace:${commandId}:outcome`);
    if (!rawPrepared) {
      if (rawOutcome) throw new Error("WORKSPACE_OUTCOME_WITHOUT_PREPARE");
      return { kind: "not_dispatched" } satisfies { kind: "not_dispatched" };
    }
    const prepared = preparedSchema.parse(rawPrepared.data);
    if (prepared.commandId !== commandId || prepared.request.commandId !== commandId || prepared.requestBodyHash !== hashTaskBytes(JSON.stringify(prepared.request)) || hashTaskValue(prepared.binding) !== hashTaskValue(binding)) throw new Error("WORKSPACE_RECEIPT_BINDING_MISMATCH");
    if (!rawOutcome) return { kind: "prepared", prepared } satisfies { kind: "prepared"; prepared: typeof prepared };
    const saved = terminalSchema.parse(rawOutcome.data);
    if (saved.preparedHash !== hashTaskValue(prepared) || state.observations.indexOf(rawOutcome) <= state.observations.indexOf(rawPrepared)) throw new Error("WORKSPACE_OUTCOME_BINDING_MISMATCH");
    return { kind: "outcome", prepared, outcome: saved.outcome, outcomeHash: hashTaskValue(rawOutcome.data) } satisfies { kind: "outcome"; prepared: typeof prepared; outcome: typeof saved.outcome; outcomeHash: string };
}

export class IsolatedWorkspaceClient {
  readonly #binding: z.infer<typeof bindingSchema>;
  readonly #policy: EvidencePolicy;
  #reference: TaskSessionRef;
  #busy = false;
  constructor(input: { binding: unknown; policy: EvidencePolicy; reference: unknown }) {
    this.#binding = parseWorkspaceBinding(input.binding);
    this.#policy = input.policy;
    this.#reference = taskSessionRefSchema.parse(input.reference);
    verifyTaskSession(input.policy, this.#reference);
  }
  get reference() { return { ...this.#reference }; }
  getReceipt(commandId: string) {
    return inspectWorkspaceReceipt({ state: verifyTaskSession(this.#policy, this.#reference), binding: this.#binding, commandId });
  }
  async #fetch(path: string, method = "GET", body?: string) {
    const identity = this.#binding.instance;
    const response = await fetch(new URL(path, this.#binding.baseURL), {
      method, body, redirect: "manual", cache: "no-store", signal: AbortSignal.timeout(this.#binding.timeoutMs),
      headers: { "content-type": "application/json", "x-pitchroom-eval-instance": identity.instanceId, "x-pitchroom-eval-source": identity.sourceFingerprint, "x-pitchroom-eval-target": identity.targetFingerprint },
    });
    if (response.status >= 300 && response.status < 400) { await response.body?.cancel(); throw new Error("WORKSPACE_REDIRECT_REFUSED"); }
    const reader = response.body?.getReader();
    const chunks: Uint8Array[] = []; let bytes = 0;
    if (reader) try {
      while (true) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > this.#binding.maximumResponseBytes) throw new Error("WORKSPACE_RESPONSE_LIMIT");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    const buffer = Buffer.concat(chunks);
    const payload: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
    return { status: response.status, mode: response.headers.get("x-pitchroom-mode"), payload, bodyHash: hashTaskBytes(buffer) };
  }
  async #verifyInstance() {
    // This receipt must come from an operator-owned isolated launch, never discovery of a daily service.
    process.kill(this.#binding.instance.pid, 0);
    const response = await this.#fetch("/api/health");
    const health = z.object({ status: z.literal("ready"), runtime: z.enum(["fixture", "postgres-fake"]), evaluationInstance: evaluationInstanceSchema }).parse(response.payload);
    if (response.status !== 200 || health.runtime !== this.#binding.instance.runtime || hashTaskValue(health.evaluationInstance) !== hashTaskValue(this.#binding.instance)) throw new Error("WORKSPACE_INSTANCE_MISMATCH");
  }
  #parseWorkspace(response: { mode: string | null; payload: unknown }) {
    const state = workspaceStateSchema.parse(response.payload);
    const expectedMode = this.#binding.instance.runtime === "fixture" ? "synthetic-fixture" : "postgres-fake";
    if (state.project.id !== this.#binding.projectId || state.mode !== expectedMode || response.mode !== this.#binding.instance.runtime) throw new Error("WORKSPACE_PROJECT_OR_RUNTIME_MISMATCH");
    return state;
  }
  async read() {
    await this.#verifyInstance();
    const response = await this.#fetch("/api/workspace");
    if (response.status !== 200) throw new Error("WORKSPACE_READ_FAILED");
    return { state: this.#parseWorkspace(response), bodyHash: response.bodyHash };
  }
  #append(id: string, input: z.infer<typeof preparedSchema>, data: unknown) {
    this.#reference = appendTaskObservation(this.#policy, this.#reference, {
      id, at: new Date().toISOString(), stage: input.stage, attemptId: input.attemptId, commandId: input.commandId,
      checkpointHash: null, kind: "observation", data: z.json().parse(data),
    });
  }
  async #recover(prepared: z.infer<typeof preparedSchema>): Promise<WorkspaceCommandOutcome> {
    try {
      const readback = await this.read(), capability = workspaceRecoveryCapabilities[prepared.request.action];
      const state = readback.state, commandId = prepared.commandId;
      if (capability === "clarification_submission" && prepared.request.action === "submit_clarification") {
        const request = prepared.request;
        if (state.clarifications?.some(item => item.commandId === commandId && item.projectId === this.#binding.projectId && item.answer === request.text && item.baseRevision === request.expectedRevision && item.reassessment?.rebasedFromTaskId === request.rebaseTaskId && hashTaskValue(item.selection ?? null) === hashTaskValue(request.selection ?? null))) return { kind: "recovered", state, responseBodyHash: readback.bodyHash, proof: capability };
      }
      return { kind: "outcome_unknown", reason: "unconfirmed_mutation" };
    } catch { return { kind: "outcome_unknown", reason: "readback_unavailable" }; }
  }
  async execute(raw: unknown): Promise<WorkspaceCommandOutcome> {
    if (this.#busy) throw new Error("WORKSPACE_CLIENT_BUSY");
    this.#busy = true;
    try { return await this.#execute(raw); } finally { this.#busy = false; }
  }
  async #execute(raw: unknown): Promise<WorkspaceCommandOutcome> {
    const input = z.object({ attemptId: z.string().min(1), stage: taskStageSchema, expectedRevision: z.number().int().nonnegative(), command: workspaceCommandSchema }).strict().parse(raw);
    const command = input.command;
    if (!command.commandId || workspaceRecoveryCapabilities[command.action] === "forbidden") throw new Error("WORKSPACE_COMMAND_ID_OR_ACTION_REFUSED");
    if ("expectedRevision" in command && command.expectedRevision !== input.expectedRevision) throw new Error("WORKSPACE_EXPECTED_REVISION_MISMATCH");
    const body = JSON.stringify(command), requestBodyHash = hashTaskBytes(body);
    const journal = verifyTaskSession(this.#policy, this.#reference);
    this.#reference = journal.reference;
    const preparedId = `workspace:${command.commandId}:prepared`, terminalId = `workspace:${command.commandId}:outcome`;
    const prior = journal.observations.find(item => item.id === preparedId);
    let prepared: z.infer<typeof preparedSchema>;
    if (prior) {
      prepared = preparedSchema.parse(prior.data);
      if (prepared.requestBodyHash !== requestBodyHash || prepared.attemptId !== input.attemptId || prepared.stage !== input.stage || prepared.expectedRevision !== input.expectedRevision || hashTaskValue(prepared.binding) !== hashTaskValue(this.#binding)) throw new Error("WORKSPACE_COMMAND_REUSE_CONFLICT");
      const terminal = journal.observations.find(item => item.id === terminalId);
      if (terminal) { const saved = terminalSchema.parse(terminal.data); if (saved.preparedHash !== hashTaskValue(prepared)) throw new Error("WORKSPACE_OUTCOME_BINDING_MISMATCH"); return saved.outcome; }
      const outcome = await this.#recover(prepared);
      this.#append(terminalId, prepared, { kind: "workspace_command_outcome", preparedHash: hashTaskValue(prepared), outcome });
      return outcome;
    }
    if (journal.observations.some(item => item.attemptId === input.attemptId && preparedSchema.safeParse(item.data).success)) throw new Error("WORKSPACE_ATTEMPT_REUSE_CONFLICT");
    for (const observation of journal.observations) {
      const earlier = preparedSchema.safeParse(observation.data);
      if (!earlier.success) continue;
      const completed = journal.observations.find(item => item.id === `workspace:${earlier.data.commandId}:outcome`);
      if (!completed || terminalSchema.parse(completed.data).outcome.kind === "outcome_unknown") throw new Error("WORKSPACE_UNRESOLVED_COMMAND_HOLD");
    }
    const baseline = await this.read();
    if (baseline.state.project.revision !== input.expectedRevision) throw new Error("WORKSPACE_BASELINE_REVISION_MISMATCH");
    if (baseline.state.clarifications?.some(item => item.commandId === command.commandId || item.decisionCommandId === command.commandId || item.attempts.some(attempt => attempt.commandId === command.commandId)) || baseline.state.story?.proposals.some(item => item.commandId === command.commandId || ((item.state.kind === "applied" || item.state.kind === "kept") && item.state.commandId === command.commandId))) throw new Error("WORKSPACE_COMMAND_ALREADY_EXISTS");
    // Distinct claims cannot collapse into an idempotent ledger append in the same millisecond.
    prepared = preparedSchema.parse({ kind: "workspace_command_prepared", dispatchOwner: randomUUID(), binding: this.#binding, attemptId: input.attemptId, stage: input.stage, commandId: command.commandId, request: command, requestBodyHash, baselineHash: hashTaskValue(baseline.state), expectedRevision: input.expectedRevision });
    this.#append(preparedId, prepared, prepared);
    let outcome: WorkspaceCommandOutcome;
    try {
      await this.#verifyInstance();
      const response = await this.#fetch("/api/workspace", "POST", body);
      if (response.status === 409) outcome = { kind: "conflict", status: 409 };
      else if (response.status >= 200 && response.status < 300) outcome = { kind: "confirmed", state: this.#parseWorkspace(response), responseBodyHash: response.bodyHash };
      else outcome = await this.#recover(prepared);
    } catch { outcome = await this.#recover(prepared); }
    this.#append(terminalId, prepared, { kind: "workspace_command_outcome", preparedHash: hashTaskValue(prepared), outcome });
    return outcome;
  }
}
