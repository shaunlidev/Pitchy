import {
  PitchroomError,
  understandingProposalV1Schema,
  validateProposalEvidence,
  type AgentEvent,
  type ProjectPhase,
  type UnderstandingProposalV1,
} from "@pitchroom/domain";
import { executeAgentTool, type AgentToolCall, type ToolRepository } from "./tools";
import { validateAgentAuthorship } from "./controller";

export type AgentAction =
  | { type: "tool"; call: AgentToolCall }
  | { type: "submit"; proposal: unknown; publicSummary: string };

export interface StepAgent {
  next(context: {
    projectId: string;
    step: number;
    observations: readonly unknown[];
  }): Promise<AgentAction>;
}

export type RunBudgets = {
  maxSteps: number;
  maxToolCalls: number;
  maxRepeatedCall: number;
  maxConsecutiveToolFailures: number;
  maxReturnedCharacters: number;
  timeoutMs: number;
};

export const defaultRunBudgets: RunBudgets = {
  maxSteps: 8,
  maxToolCalls: 20,
  maxRepeatedCall: 3,
  maxConsecutiveToolFailures: 3,
  maxReturnedCharacters: 120_000,
  timeoutMs: 120_000,
};

export type OrchestratedRun = {
  phase: "review_required";
  proposal: UnderstandingProposalV1;
  publicSummary: string;
  events: AgentEvent[];
};

export async function orchestrateUnderstandingRun(input: {
  runId: string;
  projectId: string;
  currentPhase: ProjectPhase;
  agent: StepAgent;
  repository: ToolRepository;
  now?: () => string;
  budgets?: Partial<RunBudgets>;
  signal?: AbortSignal;
}): Promise<OrchestratedRun> {
  if (input.currentPhase !== "materials_ready") {
    throw new PitchroomError("INVALID_TRANSITION", "A run can start only when materials are ready.");
  }
  const budgets = { ...defaultRunBudgets, ...input.budgets };
  const now = input.now ?? (() => new Date().toISOString());
  const events: AgentEvent[] = [];
  const observations: unknown[] = [];
  const repeated = new Map<string, number>();
  let toolCalls = 0;
  let consecutiveToolFailures = 0;
  let returnedCharacters = 0;
  const append = (type: AgentEvent["type"], payload: Record<string, unknown>) => {
    events.push({ runId: input.runId, sequence: events.length + 1, type, timestamp: now(), payload });
  };
  append("run_started", { projectId: input.projectId });
  append("phase_changed", { from: "materials_ready", to: "reading" });

  const startedAt = Date.now();
  const remainingMs = () => Math.max(0, budgets.timeoutMs - (Date.now() - startedAt));
  const bounded = async <T>(operation: Promise<T>): Promise<T> => {
    const timeLeft = remainingMs();
    if (timeLeft <= 0) throw new PitchroomError("BUDGET_EXCEEDED", "Agent wall-clock budget exceeded.");
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); input.signal?.removeEventListener("abort", onAbort); };
      const succeed = (value: T) => { if (settled) return; settled = true; cleanup(); resolve(value); };
      const fail = (error: unknown) => { if (settled) return; settled = true; cleanup(); reject(error); };
      const onAbort = () => fail(new PitchroomError("CANCELLED", "Run was cancelled."));
      const timer = setTimeout(() => fail(new PitchroomError("BUDGET_EXCEEDED", "Agent wall-clock budget exceeded.")), timeLeft);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      operation.then(succeed, fail);
    });
  };

  try {
    for (let step = 1; step <= budgets.maxSteps; step += 1) {
      if (input.signal?.aborted) throw new PitchroomError("CANCELLED", "Run was cancelled.");
      const action = await bounded(input.agent.next({ projectId: input.projectId, step, observations }));
      if (action.type === "submit") {
        append("proposal_received", { step });
        const proposal = understandingProposalV1Schema.parse(action.proposal);
        validateAgentAuthorship(proposal);
        const sources = await input.repository.listSources(input.projectId);
        validateProposalEvidence(proposal, sources.flatMap((source) => source.chunks));
        append("phase_changed", { from: "reading", to: "structuring" });
        append("version_created", { schemaVersion: proposal.schemaVersion });
        append("phase_changed", { from: "structuring", to: "review_required" });
        append("run_completed", { step, toolCalls });
        return { phase: "review_required", proposal, publicSummary: action.publicSummary, events };
      }

      toolCalls += 1;
      if (toolCalls > budgets.maxToolCalls) {
        throw new PitchroomError("BUDGET_EXCEEDED", "Tool-call budget exceeded.");
      }
      const key = JSON.stringify(action.call);
      const count = (repeated.get(key) ?? 0) + 1;
      repeated.set(key, count);
      if (count > budgets.maxRepeatedCall) {
        throw new PitchroomError("BUDGET_EXCEEDED", "Repeated tool-call circuit breaker opened.");
      }
      append("tool_called", { step, name: action.call.name });
      try {
        const result = await bounded(executeAgentTool(input.projectId, action.call, input.repository));
        returnedCharacters += JSON.stringify(result).length;
        if (returnedCharacters > budgets.maxReturnedCharacters) throw new PitchroomError("BUDGET_EXCEEDED", "Tool-result character budget exceeded.");
        observations.push({ call: action.call, result });
        consecutiveToolFailures = 0;
        append("tool_succeeded", { step, name: action.call.name, returnedCharacters });
      } catch (error) {
        consecutiveToolFailures += 1;
        observations.push({ call: action.call, error: error instanceof Error ? error.message : "Unknown error" });
        append("tool_failed", { step, name: action.call.name, message: error instanceof Error ? error.message : "Unknown error" });
        if (error instanceof PitchroomError && (error.code === "BUDGET_EXCEEDED" || error.code === "CANCELLED")) throw error;
        if (consecutiveToolFailures >= budgets.maxConsecutiveToolFailures) throw error;
      }
    }
    throw new PitchroomError("BUDGET_EXCEEDED", "Model-step budget exceeded.");
  } catch (error) {
    append("run_failed", {
      code: error instanceof PitchroomError ? error.code : "PROPOSAL_REJECTED",
      message: error instanceof Error ? error.message : "Unknown error",
    });
    throw Object.assign(error instanceof Error ? error : new Error("Unknown error"), { events });
  }
}
