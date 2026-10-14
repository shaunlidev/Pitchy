import { describe, expect, it } from "vitest";
import { replayTerminalPhase, type AgentEvent } from "./events";

describe("event replay", () => {
  it("replays by sequence rather than array order", () => {
    const event = (sequence: number, to: string): AgentEvent => ({
      runId: "run",
      sequence,
      type: "phase_changed",
      timestamp: "2026-10-14T00:00:00.000Z",
      payload: { to },
    });
    expect(replayTerminalPhase([event(2, "review_required"), event(1, "reading")])).toBe(
      "review_required",
    );
  });
});
