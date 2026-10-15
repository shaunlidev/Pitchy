// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      const body = JSON.parse(String(init.body)) as { action: string; text?: string; expectedRevision?: number; sourceId?: string };
      if (body.action === "answer") return jsonResponse(answerFixtureQuestion(body.text ?? "", body.expectedRevision ?? -1));
      if (body.action === "correct") return jsonResponse(correctFixtureClaim(body.text ?? "", body.expectedRevision ?? -1));
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
    const correction = await screen.findByLabelText("Correct the first claim") as HTMLTextAreaElement;
    await user.type(correction, "Atelier shortens client-deck preparation.");
    await user.click(screen.getByRole("button", { name: "Record correction" }));
    await waitFor(() => expect(correction.value).toBe(""));
    expect((screen.getByRole("button", { name: "Record correction" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Atelier shortens client-deck preparation.")).toBeTruthy();
    expect(screen.getByText(/^User input ·/)).toBeTruthy();
  });

  it("opens explicit upload and removal dialogs from the default Materials home", async () => {
    const user = userEvent.setup();
    render(<HomePage />);
    expect(await screen.findByRole("heading", { name: "Your project materials." })).toBeTruthy();
    expect(screen.queryByText("External AI is enabled for this project.")).toBeNull();
    await user.click(screen.getByRole("button", { name: /Add files/ }));
    expect(screen.getByRole("dialog", { name: "Add source material" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await user.click(screen.getByRole("button", { name: "Remove brief.md" }));
    expect(screen.getByRole("alertdialog", { name: "Remove this source?" })).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Remove file" }));
    await waitFor(() => expect(screen.queryByText("brief.md")).toBeNull());
  });
});
