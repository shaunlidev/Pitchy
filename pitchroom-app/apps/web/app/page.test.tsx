// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addFixtureMaterial, answerFixtureQuestion, correctFixtureClaim, readFixtureState, resetFixtureState, runFixtureAgent } from "../lib/fixture-store";
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
      const body = JSON.parse(String(init.body)) as { action: string; text?: string; expectedRevision?: number };
      if (body.action === "answer") return jsonResponse(answerFixtureQuestion(body.text ?? "", body.expectedRevision ?? -1));
      if (body.action === "correct") return jsonResponse(correctFixtureClaim(body.text ?? "", body.expectedRevision ?? -1));
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
    const correction = await screen.findByLabelText("Correct the first claim") as HTMLTextAreaElement;
    await user.type(correction, "Atelier shortens client-deck preparation.");
    await user.click(screen.getByRole("button", { name: "Record correction" }));
    await waitFor(() => expect(correction.value).toBe(""));
    expect((screen.getByRole("button", { name: "Record correction" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Atelier shortens client-deck preparation.")).toBeTruthy();
    expect(screen.getByText(/^User input ·/)).toBeTruthy();
  });
});
