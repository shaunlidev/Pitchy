import { isAbsolute } from "node:path";
import { z } from "zod";
import { inspectProviderBudget, providerBudgetOperationSchema } from "@pitchroom/agent";

const inputSchema = z.object({ directory: z.string().refine(isAbsolute), policyHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
export function auditProviderBudget(raw: unknown) {
  const input = inputSchema.parse(raw), state = inspectProviderBudget(input.directory, input.policyHash);
  const remaining = { requests: state.policy.limits.requests - state.used.requests, inputTokens: state.policy.limits.inputTokens - state.used.inputTokens,
    outputTokens: state.policy.limits.outputTokens - state.used.outputTokens, microUsd: state.policy.limits.microUsd - state.used.microUsd,
    modelActiveMs: state.policy.limits.modelActiveMs - state.used.modelActiveMs, ledgerBytes: state.policy.limits.ledgerBytes - state.bytes };
  const stages = providerBudgetOperationSchema.shape.stage.options.map(stage => {
    const calls = state.calls.filter(call => call.reservation.stage === stage);
    const activeMs = calls.reduce((total, call) => total + (call.outcome.kind === "settled" ? call.outcome.value.modelActiveMs : call.reservation.modelActiveMs), 0);
    return { stage, requests: calls.length, activeMs, remainingActiveMs: state.policy.limits.stageModelActiveMs[stage] - activeMs };
  });
  return { kind: "provider_budget_integrity_only", policyHash: input.policyHash, policy: state.policy, state: state.state,
    usedIncludingConservativeReservations: state.used, remaining, stages,
    sessions: [...new Set(state.calls.map(call => call.reservation.sessionId))],
    calls: state.calls.map(call => ({ ...call.reservation, outcome: call.outcome.kind, settled: call.outcome.kind === "settled" ? call.outcome.value : null })),
    modelQuality: "not_evaluated", taskAcceptance: "not_evaluated", liveAdmission: "not_granted",
  };
}
