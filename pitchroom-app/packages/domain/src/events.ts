import { z } from "zod";

export const agentEventTypeSchema = z.enum([
  "run_started",
  "phase_changed",
  "tool_called",
  "tool_succeeded",
  "tool_failed",
  "proposal_received",
  "proposal_rejected",
  "version_created",
  "run_completed",
  "run_failed",
  "run_cancelled",
  "user_input_recorded",
  "understanding_accepted",
]);

export const agentEventSchema = z.object({
  runId: z.string().min(1),
  sequence: z.number().int().positive(),
  type: agentEventTypeSchema,
  timestamp: z.string().datetime(),
  payload: z.record(z.string(), z.unknown()),
});

export type AgentEvent = z.infer<typeof agentEventSchema>;

export function replayTerminalPhase(events: readonly AgentEvent[]): string | undefined {
  let phase: string | undefined;
  for (const event of [...events].sort((a, b) => a.sequence - b.sequence)) {
    if (event.type === "phase_changed" && typeof event.payload.to === "string") {
      phase = event.payload.to;
    }
  }
  return phase;
}
