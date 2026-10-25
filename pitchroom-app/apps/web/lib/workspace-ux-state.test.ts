import { beforeEach, describe, expect, it } from "vitest";
import { acceptFixture, addFixtureMaterial, generateFixturePositioning, readFixtureState, resetFixtureState, runFixtureAgent } from "./fixture-store";
import { createWorkspaceActionError, deriveWorkspaceUXState, type ActiveAgentRequest } from "./workspace-ux-state";

const request = (kind: ActiveAgentRequest["kind"], state = readFixtureState()): ActiveAgentRequest => ({
  kind,
  commandId: `${kind}-command`,
  startedAt: new Date(Date.now() - 1_000).toISOString(),
  startSequence: state.events.at(-1)?.sequence ?? 0,
  workflowRunIdsAtStart: state.workflowRuns.map(run => run.id),
});

describe("workspace UX state", () => {
  beforeEach(() => resetFixtureState());

  it("does not describe a completed positioning run as working", () => {
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
    const reviewed = runFixtureAgent();
    acceptFixture(reviewed.project.revision);
    const before = readFixtureState();
    const active = request("positioning", before);
    const completed = generateFixturePositioning(before.project.revision);
    completed.workflowRuns.push({
      id: "positioning-run",
      kind: "positioning",
      status: "completed",
      events: [
        { type: "run_started", detail: "started", at: new Date().toISOString() },
        { type: "run_completed", detail: "saved", at: new Date().toISOString() },
      ],
    });
    completed.events.push({ sequence: completed.events.length + 1, label: "Positioning agent started", detail: "started", at: new Date().toISOString() });
    completed.events.push({ sequence: completed.events.length + 1, label: "Directions ready", detail: "saved", at: new Date().toISOString() });

    expect(deriveWorkspaceUXState(completed, active).activity?.status).toBe("completed");
  });

  it("restores a persisted running workflow without client request state", () => {
    const state = readFixtureState();
    state.workflowRuns.push({ id: "deck-run", kind: "deck", status: "running", events: [{ type: "run_started", detail: "started", at: new Date().toISOString() }] });
    expect(deriveWorkspaceUXState(state).activity).toMatchObject({ kind: "deck", status: "running" });
  });

  it("keeps earlier Story failures out of a new positioning request before and after its run starts", () => {
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
    const reviewed = runFixtureAgent();
    const state = acceptFixture(reviewed.project.revision);
    const at = new Date().toISOString();
    state.workflowRuns = [
      { id: "old-positioning", kind: "positioning", status: "completed", events: [{ type: "run_started", detail: "old positioning", at }, { type: "run_completed", detail: "saved directions", at }] },
      { id: "failed-story", kind: "story", status: "failed", events: [{ type: "run_started", detail: "old story", at }, { type: "run_failed", detail: "error: null", at }] },
      { id: "completed-story", kind: "story", status: "completed", events: [{ type: "run_started", detail: "later story", at }, { type: "run_completed", detail: "saved story", at }] },
    ];
    state.events.push(
      { sequence: state.events.length + 1, label: "Positioning agent started", detail: "old positioning", at },
      { sequence: state.events.length + 2, label: "Story agent failed", detail: "error: null", at },
      { sequence: state.events.length + 3, label: "Story proposal ready", detail: "saved story", at },
    );
    const active = request("positioning", state);
    const starting = deriveWorkspaceUXState(state, active);
    expect(starting.activity).toMatchObject({ kind: "positioning", status: "queued", events: [] });
    expect(starting.mutationLocked).toBe(true);

    state.workflowRuns.push({ id: "new-positioning", kind: "positioning", status: "running", events: [{ type: "run_started", detail: "current positioning", at }] });
    const running = deriveWorkspaceUXState(state, active);
    expect(running.activity).toMatchObject({ kind: "positioning", status: "running" });
    expect(running.activity?.events.map(event => event.detail)).toEqual(["current positioning"]);
    expect(running.mutationLocked).toBe(true);
    expect(deriveWorkspaceUXState(state).activity?.events.map(event => event.detail)).toEqual(["current positioning"]);
    expect(state.workflowRuns.find(run => run.id === "failed-story")?.status).toBe("failed");
  });

  it("describes a Story run and its next decision without Deck or understanding labels", () => {
    const state = readFixtureState();
    const active = request("story", state);
    const at = new Date().toISOString();
    state.workflowRuns.push({ id: "story", kind: "story", status: "completed", events: [
      { type: "run_started", detail: "story started", at },
      { type: "proposal_validated", detail: "story validated", at },
      { type: "run_completed", detail: "story saved", at },
    ] });
    const ux = deriveWorkspaceUXState(state, active);
    expect(ux.activity).toMatchObject({ kind: "story", status: "completed", title: "Developing your story proposal" });
    expect(ux.activity?.events.map(event => event.label)).toEqual(["Story agent started", "Story proposal validated", "Story proposal ready"]);
    expect(ux.checkpoint).toContain("apply or keep your current story");
  });

  it("turns technical failures into an actionable recovery contract", () => {
    const failure = createWorkspaceActionError({ code: "PERSISTENCE_ERROR", technicalMessage: "connection reset", requestId: "request-1", action: "deck", commandId: "deck-1" });
    expect(failure.message).not.toContain("connection reset");
    expect(failure.recovery).toBe("retry");
    expect(failure.outcomeUnknown).toBe(true);
    expect(failure.commandId).toBe("deck-1");
  });

  it("offers an explicit retry for a confirmed provider timeout without blaming the input", () => {
    const failure = createWorkspaceActionError({ code: "PROVIDER_TIMEOUT", technicalMessage: "response_headers", action: "positioning", commandId: "timed-out" });
    expect(failure.message).toContain("timed out");
    expect(failure.message).toContain("preserved");
    expect(failure.recovery).toBe("retry");
    expect(failure.outcomeUnknown).toBe(false);
  });
});

describe("P1 next action and access", () => {
  beforeEach(() => resetFixtureState());
  it("keeps all stages revisitable without requiring answers", () => {
    let state = readFixtureState();
    expect(deriveWorkspaceUXState(state).access.positioning.allowed).toBe(false);
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier prepares client presentations." });
    state = runFixtureAgent();
    expect(deriveWorkspaceUXState(state, undefined, { destination: "clarify" }).primary).toBe("accept");
    expect(deriveWorkspaceUXState(state, undefined, { destination: "clarify", answer: "A decision" }).primary).toBe("answer");
    expect(deriveWorkspaceUXState(state, undefined, { destination: "clarify", correction: "Correction" }).primary).toBe("correct");
    state = acceptFixture(state.project.revision);
    expect(deriveWorkspaceUXState(state).access.positioning.allowed).toBe(true);
    expect(deriveWorkspaceUXState(state, undefined, { destination: "positioning" }).primary).toBe("generate_positioning");
  });
  it("blocks new mutations during persisted runs and unknown outcomes", () => {
    const state = readFixtureState();
    state.workflowRuns.push({ id: "run", kind: "deck", status: "running", events: [] });
    expect(deriveWorkspaceUXState(state).mutationLocked).toBe(true);
    expect(deriveWorkspaceUXState(state).checkpoint).toContain("review the saved deck");
    state.workflowRuns = [];
    const error = createWorkspaceActionError({ code: "NETWORK_ERROR", technicalMessage: "offline" });
    expect(deriveWorkspaceUXState(state, undefined, { error }).primary).toBe("none");
  });
});
