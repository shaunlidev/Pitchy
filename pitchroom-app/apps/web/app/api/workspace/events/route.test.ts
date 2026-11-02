import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addFixtureMaterial, resetFixtureState, runFixtureAgent } from "../../../../lib/fixture-store";
import { GET } from "./route";

beforeEach(() => resetFixtureState());
afterEach(() => vi.unstubAllEnvs());

describe("workspace event stream", () => {
  it("rejects an invalid runtime before opening a stream or reading storage", async () => {
    vi.stubEnv("PITCHROOM_RUNTIME", "liv-typo");
    const response = await GET(new Request("http://localhost/api/workspace/events?once=1"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
  it("refuses the production fixture fallback before opening an event stream", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("PITCHROOM_DEPLOYMENT_ENV", undefined);
    vi.stubEnv("PITCHROOM_RUNTIME", "fixture");
    const response = await GET(new Request("http://localhost/api/workspace/events?once=1"));
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toMatchObject({ code: "INVALID_CONFIGURATION" });
  });
  it("resumes strictly after Last-Event-ID", async () => {
    addFixtureMaterial({ name: "brief.txt", mediaType: "text/plain", text: "Revenue grew 40 percent." });
    runFixtureAgent();
    const response = await GET(new Request("http://localhost/api/workspace/events?once=1", { headers: { "last-event-id": "4" } }));
    const body = await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(body).toContain("id: 5");
    expect(body).toContain("id: 6");
    expect(body).not.toContain("id: 4");
  });
});
