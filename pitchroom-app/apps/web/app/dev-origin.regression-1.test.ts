// Regression: ISSUE-001 — 127.0.0.1 could load HTML but Next dev blocked hydration assets
// Found by /qa on 2026-10-15
// Report: .gstack/qa-reports/qa-report-127-0-0-1-2026-10-15.md

import { describe, expect, it } from "vitest";
import nextConfig from "../next.config";

describe("Next development origins", () => {
  it("allows the loopback hosts used by the local browser", () => {
    expect(nextConfig.allowedDevOrigins).toEqual(expect.arrayContaining(["127.0.0.1", "localhost"]));
  });
});
