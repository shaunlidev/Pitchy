import { beforeEach, describe, expect, it, vi } from "vitest";
import { PitchroomError } from "@pitchroom/domain";
import * as fixtureStore from "../../../lib/fixture-store";
import { errorEnvelopeSchema, readMaterialImportResponse, workspaceStateSchema } from "../../../lib/api-contract";
import { resetFixtureState } from "../../../lib/fixture-store";
import { GET, POST } from "./route";
import { workspaceResponse } from "../../../lib/runtime-responses";

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
    const before = await (await GET(new Request("http://localhost/api/workspace"))).json();
    vi.spyOn(fixtureStore, "generateFixturePositioning").mockImplementation(() => {
      throw new PitchroomError("PROVIDER_TIMEOUT", "The positioning provider timed out.", { stage: "positioning", phase: "response_headers", timeoutMs: 60_000 });
    });
    const response = await POST(request({ action: "generate_positioning", commandId: "timeout-1", expectedPositioning:{positioningId:null,decisionId:null}, expectedRevision: 0 }));
    expect(response.status).toBe(504);
    expect(await response.json()).toMatchObject({ code: "PROVIDER_TIMEOUT", details: { stage: "positioning", phase: "response_headers" } });
    expect(await (await GET(new Request("http://localhost/api/workspace"))).json()).toEqual(before);
  });

  it("returns a response-validated initial state with request metadata", async () => {
    const response = await GET(new Request("http://localhost/api/workspace"));
    expect(workspaceStateSchema.parse(await response.json()).project.phase).toBe("empty");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
  });

  it("returns the saved file identity only on import POSTs and preserves the legacy workspace response", async () => {
    const a = { action: "add_material", name: "a.md", mediaType: "text/markdown", text: "A synthetic source." };
    const send = async (body: unknown) => {
      const response = await POST(request(body));
      expect(response.status).toBe(200);
      return response.json();
    };
    const first = await send({ ...a, commandId: "one" });
    const sourceId = first.sources[0].sourceId;
    expect(first.materialImport).toEqual({ commandId: "one", sourceId, sourceName: "a.md", outcome: "created" });
    expect(workspaceStateSchema.parse(first)).not.toHaveProperty("materialImport");
    const reviewed = await send({ action: "run", commandId: "understand" });
    expect(reviewed).not.toHaveProperty("materialImport");
    const sameContent = { ...a, name: "b.txt", mediaType: "text/plain" };
    const reused = await send({ ...sameContent, commandId: "two" });
    expect(reused.materialImport).toEqual({ commandId: "two", sourceId, sourceName: "a.md", outcome: "reused" });
    expect(reused.currentVersionId).toBe(reviewed.currentVersionId);
    expect(reused.sources).toHaveLength(1);
    const topic = { kind: "theme", index: 0, understandingId: reviewed.currentVersionId };
    const attach = { ...sameContent, action: "attach_topic_material", topic, commandId: "three" };
    const attached = await send(attach);
    expect(attached.materialImport).toEqual({ commandId: "three", sourceId, sourceName: "a.md", outcome: "reused" });
    expect(attached.topicMaterials).toContainEqual(expect.objectContaining({ ...topic, sourceId }));
    const unlinked = await send({ action: "unlink_topic_material", topic, sourceId, commandId: "unlink" });
    expect(unlinked).not.toHaveProperty("materialImport");
    const replay = await send(attach);
    expect(replay.materialImport).toEqual({ commandId: "three", sourceId, sourceName: "a.md", outcome: "replayed" });
    expect(replay.topicMaterials).toEqual([]);
    const current = await (await GET(new Request("http://localhost/api/workspace"))).json();
    expect(current).not.toHaveProperty("materialImport");
    expect(workspaceStateSchema.parse(replay)).toEqual(current);
    expect(readMaterialImportResponse(replay, "three")).toBeDefined();
    expect(readMaterialImportResponse(replay, "wrong-command")).toBeUndefined();
    expect(readMaterialImportResponse({ ...replay, materialImport: { ...replay.materialImport, sourceName: "invented.txt" } }, "three")).toBeUndefined();
    expect(readMaterialImportResponse(current, "three")).toBeUndefined();
  });

  it("returns a storage error when the post-commit file receipt cannot be confirmed", async () => {
    const save = fixtureStore.addFixtureMaterialWithReceipt;
    vi.spyOn(fixtureStore, "addFixtureMaterialWithReceipt").mockImplementation((file, commandId) => {
      const result = save(file, commandId);
      return { ...result, materialImport: { ...result.materialImport, commandId: "another-command" } };
    });
    const response = await POST(request({ action: "add_material", name: "source.txt", mediaType: "text/plain", text: "Persisted once.", commandId: "original" }));
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ code: "PERSISTENCE_ERROR" });
    expect(fixtureStore.readFixtureState().sources).toHaveLength(1);
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
    expect(workspaceStateSchema.parse(await (await GET(new Request("http://localhost/api/workspace"))).json()).project.phase).toBe("empty");
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
