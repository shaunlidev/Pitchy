import { beforeEach, describe, expect, it, vi } from "vitest";
import { PitchroomError } from "@pitchroom/domain";
import * as fixtureStore from "../../../lib/fixture-store";
import { errorEnvelopeSchema, workspaceStateSchema } from "../../../lib/api-contract";
import { resetFixtureState } from "../../../lib/fixture-store";
import { GET, POST, workspaceResponse } from "./route";

const request = (body: unknown) => new Request("http://localhost/api/workspace", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.restoreAllMocks();
  delete process.env.PITCHROOM_RUNTIME;
  resetFixtureState();
});

describe("workspace API", () => {
  it("refuses an invalid runtime without reading or mutating project state", async () => {
    process.env.PITCHROOM_RUNTIME = "liv-typo";
    const read = vi.fn(() => fixtureStore.readFixtureState());
    const response = await workspaceResponse(read);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ code: "INVALID_CONFIGURATION" });
    expect(response.headers.get("x-pitchroom-mode")).toBe("invalid");
    expect(read).not.toHaveBeenCalled();
    expect((await POST(request({ action: "run", commandId: "invalid-mode" }))).status).toBe(503);
    expect(fixtureStore.readFixtureState().project.phase).toBe("empty");
  });

  it("reports a provider timeout as 504 and preserves the workspace", async () => {
    const before = await (await GET()).json();
    vi.spyOn(fixtureStore, "generateFixturePositioning").mockImplementation(() => {
      throw new PitchroomError("PROVIDER_TIMEOUT", "The positioning provider timed out.", { stage: "positioning", phase: "response_headers", timeoutMs: 60_000 });
    });
    const response = await POST(request({ action: "generate_positioning", commandId: "timeout-1", expectedRevision: 0 }));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_TIMEOUT", details: { stage: "positioning", phase: "response_headers" } });
    expect(await (await GET()).json()).toEqual(before);
  });

  it("returns a response-validated initial state with request metadata", async () => {
    const response = await GET();
    expect(workspaceStateSchema.parse(await response.json()).project.phase).toBe("empty");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns a structured retryable response when storage is unavailable", async () => {
    const response = await workspaceResponse(async () => { throw new Error("connection failed"); });
    expect(response.status).toBe(503);
    expect(errorEnvelopeSchema.parse(await response.json())).toMatchObject({
      code: "PERSISTENCE_ERROR",
      error: "Workspace storage is temporarily unavailable. Retry in a moment.",
    });
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
