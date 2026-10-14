import { beforeEach, describe, expect, it } from "vitest";
import { addFixtureMaterial, resetFixtureState, runFixtureAgent } from "../../../../lib/fixture-store";
import { GET } from "./route";

beforeEach(() => resetFixtureState());

describe("workspace event stream", () => {
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
