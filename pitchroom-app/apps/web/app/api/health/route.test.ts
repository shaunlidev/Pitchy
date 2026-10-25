import { afterEach, describe, expect, it, vi } from "vitest";
import { healthResponse } from "./route";

const original = { runtime: process.env.PITCHROOM_RUNTIME, key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, database: process.env.DATABASE_URL, ack: process.env.PITCHROOM_LIVE_TRANSFER_ACK };
afterEach(() => {
  for (const [key, value] of Object.entries({ PITCHROOM_RUNTIME: original.runtime, OPENAI_API_KEY: original.key, OPENAI_MODEL: original.model, DATABASE_URL: original.database, PITCHROOM_LIVE_TRANSFER_ACK: original.ack })) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});

describe("health readiness", () => {
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
