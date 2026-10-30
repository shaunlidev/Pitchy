import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthResponse } from "./route";
import { deployedEnvironment } from "../../../../../packages/domain/src/runtime-configuration.testkit";

beforeEach(() => {
  for (const key of Object.keys(deployedEnvironment())) vi.stubEnv(key, undefined);
  vi.stubEnv("NODE_ENV", "test");
});

const original = { runtime: process.env.PITCHROOM_RUNTIME, key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, database: process.env.DATABASE_URL, ack: process.env.PITCHROOM_LIVE_TRANSFER_ACK };
afterEach(() => {
  for (const [key, value] of Object.entries({ PITCHROOM_RUNTIME: original.runtime, OPENAI_API_KEY: original.key, OPENAI_MODEL: original.model, DATABASE_URL: original.database, PITCHROOM_LIVE_TRANSFER_ACK: original.ack })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  vi.unstubAllEnvs();
});

describe("health readiness", () => {
  it("refuses an undeclared production environment before probing a database", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const probe = vi.fn(async () => true);
    expect((await healthResponse(probe)).status).toBe(503);
    expect(probe).not.toHaveBeenCalled();
  });

  it("does not equate valid declarations and SELECT 1 with deployment readiness", async () => {
    for (const [key, value] of Object.entries(deployedEnvironment())) vi.stubEnv(key, value);
    const probe = vi.fn(async () => true);
    const response = await healthResponse(probe);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ status: "not_ready", environment: "trial", runtime: "live", releaseSha: "a".repeat(40), expectedSchemaVersion: "synthetic-schema-1", code: "DEPLOYMENT_READINESS_UNVERIFIED", checks: { configuration: true, database: true, targetIdentity: false, schema: false, worker: false, authorization: false } });
    expect(probe).toHaveBeenCalledOnce();
    expect(JSON.stringify(body)).not.toMatch(/example|test-synthetic-provider-key|db.example/);
  });

  it("keeps probe errors redacted and recovers readiness for the same explicit local target", async () => {
    vi.stubEnv("PITCHROOM_RUNTIME", "postgres-fake");
    vi.stubEnv("DATABASE_URL", "postgres://local/test");
    const failed = await healthResponse(async () => { throw new Error("secret-database-value"); });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toContain("secret-database-value");
    const probe = vi.fn(async () => true);
    expect((await healthResponse(probe)).status).toBe(200);
    expect(probe).toHaveBeenCalledWith("postgres://local/test");
  });

  it("rejects an unknown runtime before probing storage or reporting ready", async () => {
    process.env.PITCHROOM_RUNTIME = "liv-typo";
    process.env.DATABASE_URL = "postgres://synthetic/test";
    const probe = vi.fn(async () => true);
    const response = await healthResponse(probe);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", runtime: "invalid", checks: { configuration: false, database: false, liveModel: false } });
    expect(probe).not.toHaveBeenCalled();
  });

  it("is ready in isolated fixture mode", async () => {
    process.env.PITCHROOM_RUNTIME = "fixture";
    const response = await healthResponse();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ready", runtime: "fixture" });
  });

  it("fails closed when live configuration is incomplete", async () => {
    process.env.PITCHROOM_RUNTIME = "live";
    delete process.env.OPENAI_API_KEY; delete process.env.OPENAI_MODEL; delete process.env.DATABASE_URL;
    const response = await healthResponse();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", checks: { configuration: false, liveModel: false } });
  });

  it("requires an explicit transfer acknowledgement in live mode", async () => {
    process.env.PITCHROOM_RUNTIME = "live";
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_MODEL = "pinned-model"; process.env.DATABASE_URL = "postgres://local/test";
    delete process.env.PITCHROOM_LIVE_TRANSFER_ACK;
    expect((await healthResponse(async () => true)).status).toBe(503);
    process.env.PITCHROOM_LIVE_TRANSFER_ACK = "authorized";
    expect((await healthResponse(async () => true)).status).toBe(200);
  });

  it("reports not ready when configured storage cannot be reached", async () => {
    process.env.PITCHROOM_RUNTIME = "live";
    process.env.OPENAI_API_KEY = "test-key"; process.env.OPENAI_MODEL = "pinned-model"; process.env.DATABASE_URL = "postgres://local/test"; process.env.PITCHROOM_LIVE_TRANSFER_ACK = "authorized";
    const response = await healthResponse(async () => false);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "not_ready", checks: { configuration: true, database: false, liveModel: true } });
  });
});
