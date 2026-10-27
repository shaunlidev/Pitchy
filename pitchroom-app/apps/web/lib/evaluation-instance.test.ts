import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluationInstance, evaluationRequestGuard } from "./evaluation-instance";
import { GET, POST } from "../app/api/workspace/route";
import { healthResponse } from "../app/api/health/route";

afterEach(() => vi.unstubAllEnvs());
const environment = () => ({ PITCHROOM_RUNTIME: "fixture", PITCHROOM_EVAL_INSTANCE_ID: randomUUID(), PITCHROOM_EVAL_SOURCE_HASH: "a".repeat(64) });
function configure(input = environment()) {
  for (const [name, value] of Object.entries(input)) vi.stubEnv(name, value);
  return input;
}
describe("operator-owned isolated evaluation identity", () => {
  it("is disabled without explicit configuration and does not adopt an identity header", () => {
    expect(evaluationInstance({})).toEqual({ kind: "disabled" });
    vi.stubEnv("PITCHROOM_EVAL_INSTANCE_ID", undefined); vi.stubEnv("PITCHROOM_EVAL_SOURCE_HASH", undefined);
    expect(evaluationRequestGuard()).toBeUndefined();
    expect(evaluationRequestGuard(new Request("http://127.0.0.1", { headers: { "x-pitchroom-eval-instance": randomUUID() } }))?.status).toBe(409);
  });
  it("fails closed on partial configuration, live runtime and non-QA database targets", () => {
    expect(evaluationInstance({ PITCHROOM_EVAL_INSTANCE_ID: randomUUID() }).kind).toBe("invalid");
    expect(evaluationInstance({ ...environment(), PITCHROOM_RUNTIME: "live" }).kind).toBe("invalid");
    for (const DATABASE_URL of ["postgres://qa:synthetic@localhost:5432/pit52_" + "a".repeat(32), "postgres://qa:synthetic@127.0.0.1:5432/daily", "postgres://qa:synthetic@remote.invalid:5432/pit52_" + "a".repeat(32), "postgres://qa:synthetic@127.0.0.1:5432/pit52_" + "a".repeat(32) + "?host=remote"]) {
      expect(evaluationInstance({ ...environment(), PITCHROOM_RUNTIME: "postgres-fake", DATABASE_URL }).kind).toBe("invalid");
    }
  });
  it("binds fixture process and source identity without exposing environment or database credentials", () => {
    const env = environment(), first = evaluationInstance(env, 123), second = evaluationInstance(env, 124);
    expect(first.kind).toBe("enabled"); expect(first).not.toEqual(second);
    const db = evaluationInstance({ ...env, PITCHROOM_RUNTIME: "postgres-fake", DATABASE_URL: "postgres://test-user:synthetic@127.0.0.1:55437/pit52_" + "a".repeat(32) }, 123);
    expect(db.kind).toBe("enabled"); expect(JSON.stringify(db)).not.toContain("synthetic"); expect(JSON.stringify(db)).not.toContain("test-user");
  });
  it("accepts only exact expected instance, source and data target", () => {
    configure(); const state = evaluationInstance();
    if (state.kind !== "enabled") throw new Error("Expected configured test identity");
    const headers = { "x-pitchroom-eval-instance": state.identity.instanceId, "x-pitchroom-eval-source": state.identity.sourceFingerprint, "x-pitchroom-eval-target": state.identity.targetFingerprint };
    expect(evaluationRequestGuard(new Request("http://127.0.0.1", { headers }))).toBeUndefined();
    for (const key of Object.keys(headers)) expect(evaluationRequestGuard(new Request("http://127.0.0.1", { headers: { ...headers, [key]: "wrong" } }))?.status).toBe(409);
    expect(evaluationRequestGuard()).toMatchObject({ status: 409 });
  });
  it("rejects mismatched GET and POST before storage or command body access", async () => {
    configure({ ...environment(), PITCHROOM_RUNTIME: "postgres-fake" });
    vi.stubEnv("DATABASE_URL", "postgres://qa:synthetic@127.0.0.1:1/pit52_" + "b".repeat(32));
    const request = new Request("http://127.0.0.1/api/workspace", { method: "POST", body: "invalid-json" });
    expect((await POST(request)).status).toBe(409);
    expect(request.bodyUsed).toBe(false);
    expect((await GET()).status).toBe(409);
  });
  it("returns invalid isolation configuration before health probes and workspace access", async () => {
    configure({ ...environment(), PITCHROOM_RUNTIME: "live" });
    const probe = vi.fn(async () => true);
    expect((await healthResponse(probe)).status).toBe(503); expect(probe).not.toHaveBeenCalled();
    expect((await POST(new Request("http://127.0.0.1", { method: "POST" }))).status).toBe(503);
  });
  it("health identifies the configured process while ordinary health remains unchanged", async () => {
    configure();
    const response = await healthResponse();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ runtime: "fixture", evaluationInstance: { kind: "isolated_evaluation_instance", pid: process.pid, projectSelector: "atelier" } });
    vi.stubEnv("PITCHROOM_EVAL_INSTANCE_ID", undefined); vi.stubEnv("PITCHROOM_EVAL_SOURCE_HASH", undefined);
    expect(await (await healthResponse()).json()).not.toHaveProperty("evaluationInstance");
  });
});
