import { randomUUID } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluationProviderKeys, evaluationProviderReferenceHash, evaluationProviderTargetFingerprint, initializeProviderBudget, type ProviderBudgetPolicy } from "@pitchroom/agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthResponse } from "./route";
import { deployedEnvironment } from "../../../../../packages/domain/src/runtime-configuration.testkit";

beforeEach(() => {
  for (const key of Object.keys(deployedEnvironment())) vi.stubEnv(key, undefined);
  for (const key of evaluationProviderKeys) vi.stubEnv(key, undefined);
  vi.stubEnv("NODE_ENV", "test");
});

const directories: string[] = [];
const original = { runtime: process.env.PITCHROOM_RUNTIME, key: process.env.OPENAI_API_KEY, model: process.env.OPENAI_MODEL, database: process.env.DATABASE_URL, ack: process.env.PITCHROOM_LIVE_TRANSFER_ACK };
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
    const deploymentProbe = vi.fn(async () => ({ database: true, targetIdentity: false, schema: false, worker: false, authorization: false as const, failures: ["DATABASE_IDENTITY_MISMATCH"] }));
    const response = await healthResponse(probe, deploymentProbe);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toMatchObject({ status: "not_ready", environment: "trial", runtime: "live", releaseSha: "a".repeat(40), expectedSchemaVersion: "synthetic-schema-1", code: "DEPLOYMENT_READINESS_UNVERIFIED", checks: { configuration: true, database: true, targetIdentity: false, schema: false, worker: false, authorization: false } });
    expect(probe).not.toHaveBeenCalled();
    expect(deploymentProbe).toHaveBeenCalledOnce();
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

  it("reports observed database and worker readiness while authorization remains a release gate", async () => {
    for (const [key, value] of Object.entries(deployedEnvironment())) vi.stubEnv(key, value);
    const response = await healthResponse(undefined, async () => ({ database: true, targetIdentity: true, schema: true, worker: true, authorization: false, failures: ["AUTHORIZATION_UNVERIFIED"] }));
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ checks: { targetIdentity: true, schema: true, worker: true, authorization: false } });
    const failed = await healthResponse(undefined, async () => { throw new Error("postgres://secret@localhost/private"); });
    expect(failed.status).toBe(503);
    expect(await failed.text()).not.toMatch(/secret|private|postgres:/);
  });

  it("reports a bound local budget identity without exposing runtime secrets and rejects a stale binding before probing", async () => {
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "pitchroom-pit34-health-")));
    directories.push(directory);
    const policy = {
      schemaVersion: 1, acceptanceId: randomUUID(), projectId: randomUUID(), caseHash: "a".repeat(64), sourceHash: "b".repeat(64),
      provider: "synthetic", model: "synthetic-model", observedVersion: "synthetic-model", endpoint: "https://synthetic.invalid/v1/responses",
      approval: { evidenceRef: "test-synthetic-only", approvedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
      pricing: { source: "https://synthetic.invalid/pricing", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z", inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 },
      inputCeiling: { tokens: 100, source: "https://synthetic.invalid/context", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
      limits: { requests: 2, inputTokens: 1000, outputTokens: 1000, microUsd: 3000, inputTokensPerRequest: 100, outputTokensPerRequest: 50, requestMs: 1000, modelActiveMs: 10_000, stageModelActiveMs: { understanding: 10_000, clarify: 10_000, positioning: 10_000, story: 10_000, legacy_deck: 10_000 }, requestBytes: 10_000, responseBytes: 10_000, ledgerBytes: 50_000 },
    } satisfies ProviderBudgetPolicy;
    const databaseUrl = "postgres://synthetic-user:clarify_qa@127.0.0.1:55455/pit55_" + "a".repeat(32);
    const handle = initializeProviderBudget(directory, policy);
    const reference = { schemaVersion: 1, ...handle, sessionId: randomUUID(), instanceId: randomUUID(), sourceHash: policy.sourceHash, caseHash: policy.caseHash, targetFingerprint: evaluationProviderTargetFingerprint(databaseUrl) };
    const path = join(directory, "reference.json");
    writeFileSync(path, JSON.stringify(reference), { mode: 0o600 });
    const referenceHash = evaluationProviderReferenceHash(reference);
    for (const [key, value] of Object.entries({ PITCHROOM_DEPLOYMENT_ENV: "local", PITCHROOM_RUNTIME: "live", DATABASE_URL: databaseUrl, OPENAI_API_KEY: "provider-auth-secret", OPENAI_MODEL: policy.model, OPENAI_BASE_URL: "https://synthetic.invalid/v1", PITCHROOM_LIVE_TRANSFER_ACK: "authorized", PITCHROOM_EVAL_BUDGET_FILE: path, PITCHROOM_EVAL_INSTANCE_ID: reference.instanceId, PITCHROOM_EVAL_SOURCE_HASH: policy.sourceHash, PITCHROOM_EVAL_CASE_HASH: policy.caseHash, PITCHROOM_EVAL_REFERENCE_HASH: referenceHash })) vi.stubEnv(key, value);
    const probe = vi.fn(async () => true), deploymentProbe = vi.fn(async () => { throw new Error("Unexpected deployment probe"); });
    const response = await healthResponse(probe, deploymentProbe);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({ environment: "local", runtime: "live", externalModelEnabled: true, evaluationBudgetInstance: { kind: "isolated_budget_evaluation", instanceId: reference.instanceId, referenceHash, projectId: policy.projectId } });
    expect(body).not.toHaveProperty("evaluationInstance");
    expect(JSON.stringify(body)).not.toMatch(/synthetic-user|clarify_qa|provider-auth-secret|postgres:/);
    expect(JSON.stringify(body)).not.toContain(directory);
    expect(probe).toHaveBeenCalledExactlyOnceWith(databaseUrl);
    expect(deploymentProbe).not.toHaveBeenCalled();
    probe.mockClear();
    vi.stubEnv("PITCHROOM_EVAL_REFERENCE_HASH", "f".repeat(64));
    const refused = await healthResponse(probe, deploymentProbe);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ status: "not_ready", code: "INVALID_EVALUATION_INSTANCE" });
    expect(probe).not.toHaveBeenCalled();
    expect(deploymentProbe).not.toHaveBeenCalled();
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
