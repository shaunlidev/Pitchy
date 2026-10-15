import { beforeEach, describe, expect, it } from "vitest";
import { errorEnvelopeSchema, workspaceStateSchema } from "../../../lib/api-contract";
import { resetFixtureState } from "../../../lib/fixture-store";
import { GET, POST } from "./route";

const request = (body: unknown) => new Request("http://localhost/api/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  delete process.env.PITCHROOM_RUNTIME;
  resetFixtureState();
});

describe("workspace API", () => {
  it("returns a response-validated initial state with request metadata", async () => {
    const response = await GET();
    expect(workspaceStateSchema.parse(await response.json()).project.phase).toBe("empty");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("rejects invalid commands before they reach state", async () => {
    const response = await POST(request({ action: "correct", expectedRevision: -1, text: "" }));
    expect(response.status).toBe(400);
    expect(errorEnvelopeSchema.parse(await response.json()).code).toBe("INVALID_REQUEST");
    expect(workspaceStateSchema.parse(await (await GET()).json()).project.phase).toBe("empty");
  });

  it("maps stale revisions to a stable conflict response", async () => {
    await POST(request({ action: "add_material", commandId: "add-1", name: "brief.txt", mediaType: "text/plain", text: "Revenue grew." }));
    await POST(request({ action: "run", commandId: "run-1" }));
    const response = await POST(request({ action: "accept", commandId: "accept-1", expectedRevision: 0 }));
    expect(response.status).toBe(409);
    expect(errorEnvelopeSchema.parse(await response.json()).code).toBe("CONFLICT");
  });

  it("accepts new material after review and invalidates the current understanding", async () => {
    await POST(request({ action: "add_material", commandId: "add-before-review", name: "brief.txt", mediaType: "text/plain", text: "Revenue grew." }));
    await POST(request({ action: "run", commandId: "run-before-review" }));
    const response = await POST(request({ action: "add_material", commandId: "add-after-review", name: "late.txt", mediaType: "text/plain", text: "Late material." }));
    expect(response.status).toBe(200);
    const state = workspaceStateSchema.parse(await response.json());
    expect(state.sources.map((source) => source.name)).toEqual(["brief.txt", "late.txt"]);
    expect(state.project.phase).toBe("materials_ready");
    expect(state.currentVersionId).toBeUndefined();
  });
});
