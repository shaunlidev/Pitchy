import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it } from "vitest";
import { acceptFixture, addFixtureMaterial, readFixtureState, resetFixtureState, runFixtureAgent, type FixtureState } from "./fixture-store";
import { WorkspaceView } from "./workspace-view";

const sample = "Atelier helps design teams prepare client presentations.";

function render(state: FixtureState, overrides: Partial<Parameters<typeof WorkspaceView>[0]> = {}) {
  return renderToStaticMarkup(createElement(WorkspaceView, {
    state,
    busy: false,
    error: "",
    text: sample,
    answer: "",
    correction: "",
    onTextChange: () => undefined,
    onAnswerChange: () => undefined,
    onCorrectionChange: () => undefined,
    onChooseFile: () => true,
    onCancelRun: () => undefined,
    onAction: () => true,
    ...overrides,
  }));
}

describe("WorkspaceView state matrix", () => {
  beforeEach(() => resetFixtureState());

  it.each([
    ["empty", "Start with evidence."],
    ["materials_ready", "Material is addressable."],
    ["reading", "Reading source material."],
    ["structuring", "Validating the proposed understanding."],
    ["cancelled", "The previous run was cancelled."],
    ["failed", "The previous run failed safely."],
  ] as const)("renders the %s phase", (phase, expected) => {
    if (phase !== "empty") addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: sample });
    const state = readFixtureState();
    state.project.phase = phase;
    expect(render(state)).toContain(expected);
  });

  it("renders review controls, verified evidence, labels, and disabled empty-draft actions", () => {
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: sample });
    const html = render(runFixtureAgent(), { initialDestination: "clarify" });
    expect(html).toContain("Your review is the gate");
    expect(html).toContain("Correct a specific claim");
    expect(html).toContain("Exact source quote");
    expect(html).toContain('for="answer"');
    expect(html).toContain('id="answer"');
    expect(html).toContain('for="correction"');
    expect(html).toContain('id="correction"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record answer<\/button>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Record correction<\/button>/);
  });

  it("renders busy, error, cancellation, and terminal accepted semantics", () => {
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: sample });
    const reading = readFixtureState();
    reading.project.phase = "reading";
    const busyHtml = render(reading, { busy: true, activeRequest: new AbortController(), error: "Timed out.", initialDestination: "clarify" });
    expect(busyHtml).toContain('aria-busy="true"');
    expect(busyHtml).toContain('role="alert"');
    expect(busyHtml).toContain("Timed out.");
    expect(busyHtml).toContain("Cancel run");

    const reviewed = runFixtureAgent();
    const accepted = acceptFixture(reviewed.project.revision);
    const acceptedHtml = render(accepted, { initialDestination: "clarify" });
    expect(acceptedHtml).toContain("Understanding accepted.");
    expect(acceptedHtml).toContain("The agent is stopped.");
    expect(acceptedHtml).not.toContain("Your review is the gate");
    expect(acceptedHtml).not.toContain("Correct a specific claim");
  });

  it("shows a visible recovery contract when the agent fails", () => {
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: sample });
    const failed = readFixtureState();
    failed.project.phase = "failed";
    const html = render(failed);
    expect(html).toContain("The agent did not create a new understanding.");
    expect(html).toContain("Your material is saved. You can safely retry the agent.");
  });
});
