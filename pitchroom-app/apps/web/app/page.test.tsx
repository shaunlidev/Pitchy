// @vitest-environment jsdom

import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addFixtureMaterial, answerFixtureQuestion, correctFixtureClaim, readFixtureState, removeFixtureMaterial, resetFixtureState, runFixtureAgent } from "../lib/fixture-store";
import HomePage from "./page";

class FakeEventSource {
  addEventListener() {}
  close() {}
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

describe("HomePage review interactions", () => {
  beforeEach(() => {
    resetFixtureState();
    addFixtureMaterial({ name: "brief.md", mediaType: "text/markdown", text: "Atelier helps design teams prepare client presentations." });
    runFixtureAgent();
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (!init?.method || init.method === "GET") return jsonResponse(readFixtureState());
      const body = JSON.parse(String(init.body)) as { action: string; text?: string; expectedRevision?: number; sourceId?: string; name?: string; mediaType?: "text/plain" | "text/markdown"; themeIndex?: number; claimIndex?: number };
      if (body.action === "add_material") return jsonResponse(addFixtureMaterial({ name: body.name ?? "pasted-material.md", mediaType: body.mediaType ?? "text/markdown", text: body.text ?? "" }));
      if (body.action === "answer") return jsonResponse(answerFixtureQuestion(body.text ?? "", body.expectedRevision ?? -1));
      if (body.action === "correct") return jsonResponse(correctFixtureClaim(body.text ?? "", body.themeIndex ?? -1, body.claimIndex ?? -1, body.expectedRevision ?? -1));
      if (body.action === "remove_material") return jsonResponse(removeFixtureMaterial(body.sourceId ?? ""));
      return jsonResponse({ error: "Unexpected test action" }, 400);
    }));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("clears a committed answer and disables repeat submission", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Clarify" }));
    const answer = await screen.findByLabelText("Answer the agent’s question") as HTMLTextAreaElement;
    await user.type(answer, "Approve the twelve-team pilot.");
    await user.click(screen.getByRole("button", { name: "Record answer" }));
    await waitFor(() => expect(answer.value).toBe(""));
    expect((screen.getByRole("button", { name: "Record answer" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Approve the twelve-team pilot.")).toBeTruthy();
  });

  it("clears a committed correction and keeps it user-attributed", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Clarify" }));
    const correction = await screen.findByLabelText("Your correction") as HTMLTextAreaElement;
    await user.type(correction, "Atelier shortens client-deck preparation.");
    const correctionPanel = screen.getByRole("region", { name: "Correct a specific claim" });
    await user.click(within(correctionPanel).getByRole("button", { name: "Record correction" }));
    await waitFor(() => expect(correction.value).toBe(""));
    expect((within(correctionPanel).getByRole("button", { name: "Record correction" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getAllByText("Atelier shortens client-deck preparation.").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/^User input ·/)).toBeTruthy();
  });

  it("lets the project overview change the inspected topic", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Clarify" }));

    const topicList = await screen.findByLabelText("Project topics");
    const openQuestion = within(topicList).getAllByRole("button").find((button) => button.textContent?.includes("Open question 1"));
    expect(openQuestion).toBeTruthy();
    if (!openQuestion) throw new Error("Open question control was not rendered");
    await user.click(openQuestion);

    expect(openQuestion.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Open question 1", { selector: ".overviewFocus .eyebrow" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to the current useful question" })).toBeTruthy();
  });

  it("uploads a file into the visible inventory and removes a source", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    expect(await screen.findByRole("heading", { name: "Your project materials." })).toBeTruthy();
    expect((screen.getByLabelText("Written brief") as HTMLTextAreaElement).value).toBe("");
    expect(screen.queryByText("External AI is enabled for this project.")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Add files/ }));
    expect(screen.getByRole("dialog", { name: "Add source material" })).toBeTruthy();
    const input = document.querySelector("#upload-material-file") as HTMLInputElement;
    await user.upload(input, new File(["# New evidence\nA new cited fact."], "new-evidence.md", { type: "text/markdown" }));
    expect(await screen.findByText("new-evidence.md")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Add source material" })).toBeNull();
    expect(screen.getByText("2 files")).toBeTruthy();
    expect((screen.getByRole("button", { name: /Back to Clarify/ }) as HTMLButtonElement).disabled).toBe(true);
    await user.click(screen.getByRole("button", { name: "Remove brief.md" }));
    expect(screen.getByRole("alertdialog", { name: "Remove this source?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(screen.queryByText("brief.md")).toBeNull());
  });

  it("uploads the first file from the designed dropzone and refreshes the inventory", async () => {
    resetFixtureState();
    const user = userEvent.setup();
    render(<HomePage />);

    const input = await screen.findByLabelText("Drop your materials here or choose a text or Markdown file") as HTMLInputElement;
    expect(input.parentElement?.classList.contains("dropzone")).toBe(true);
    await user.upload(input, new File(["# First evidence\nA cited fact."], "first-evidence.md", { type: "text/markdown" }));

    expect(await screen.findByText("first-evidence.md")).toBeTruthy();
    expect(screen.getByText("1 file")).toBeTruthy();
    expect(screen.getByText("Project state: materials ready")).toBeTruthy();
  });

  it("keeps the remove confirmation open when deletion fails", async () => {
    const user = userEvent.setup();
    const fetchMock = vi.mocked(fetch);
    const workingFetch = fetchMock.getMockImplementation();
    fetchMock.mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) as { action?: string } : undefined;
      if (body?.action === "remove_material") return jsonResponse({ error: "Removal failed" }, 500);
      if (!workingFetch) throw new Error("Missing test fetch implementation");
      return workingFetch(input, init);
    });

    render(<HomePage />);
    await user.click(await screen.findByRole("button", { name: "Remove brief.md" }));
    await user.click(screen.getByRole("button", { name: "Remove file" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Removal failed");
    expect(screen.getByRole("alertdialog", { name: "Remove this source?" })).toBeTruthy();
  });
});
