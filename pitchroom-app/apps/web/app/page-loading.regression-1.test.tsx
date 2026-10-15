// @vitest-environment jsdom

// Regression: ISSUE-001 — initial workspace failure rendered an endless loading screen
// Found by /qa on 2026-10-15
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-10-15.md

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import HomePage from "./page";

class FakeEventSource {
  addEventListener() {}
  close() {}
}

describe("HomePage initial-load recovery", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("shows a recoverable error instead of an endless opening state", async () => {
    vi.stubGlobal("EventSource", FakeEventSource);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      JSON.stringify({ error: "Workspace unavailable." }),
      { status: 503, headers: { "content-type": "application/json" } },
    )));

    render(<HomePage />);

    expect((await screen.findByRole("alert")).textContent).toContain("Workspace unavailable.");
    expect(screen.getByText("The workspace did not open.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Opening your project…")).toBeNull();
  });
});
