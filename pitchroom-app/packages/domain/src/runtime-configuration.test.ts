import { describe, expect, it } from "vitest";
import { configurationSummary, parseRuntimeConfiguration } from "./runtime-configuration";
import { deployedEnvironment } from "./runtime-configuration.testkit";

describe("runtime configuration boundary", () => {
  it("keeps the local development fixture default but requires explicit production identity and runtime", () => {
    expect(parseRuntimeConfiguration({})).toMatchObject({ success: true, config: { deployment: { kind: "local" }, runtime: { mode: "fixture" } } });
    expect(parseRuntimeConfiguration({ NODE_ENV: "production" }).success).toBe(false);
    expect(parseRuntimeConfiguration({ NODE_ENV: "production", PITCHROOM_RUNTIME: "fixture" }).success).toBe(false);
    expect(parseRuntimeConfiguration({ NODE_ENV: "production", PITCHROOM_DEPLOYMENT_ENV: "local" }).success).toBe(false);
    expect(parseRuntimeConfiguration({ NODE_ENV: "production", PITCHROOM_DEPLOYMENT_ENV: "local", PITCHROOM_RUNTIME: "fixture" }).success).toBe(true);
    expect(parseRuntimeConfiguration({ NODE_ENV: "prod" }).success).toBe(false);
  });

  it.each(["staging", "trial", "production"])("requires live mode and complete identity for %s", (environment) => {
    const valid = { ...deployedEnvironment(), PITCHROOM_DEPLOYMENT_ENV: environment };
    expect(parseRuntimeConfiguration(valid).success).toBe(true);
    for (const runtime of [undefined, "", "fixture", "postgres-fake", "live-typo"]) {
      expect(parseRuntimeConfiguration({ ...valid, PITCHROOM_RUNTIME: runtime }).success).toBe(false);
    }
  });

  it.each([
    "PITCHROOM_RELEASE_SHA", "PITCHROOM_SCHEMA_VERSION", "PITCHROOM_DATABASE_TARGET", "DATABASE_URL",
    "PITCHROOM_PROVIDER", "OPENAI_BASE_URL", "OPENAI_API_KEY", "OPENAI_MODEL",
    "PITCHROOM_LIVE_TRANSFER_ACK", "PITCHROOM_TRANSFER_APPROVAL_ID", "PITCHROOM_BUDGET_ID",
  ])("rejects missing or empty %s without leaking configuration values", (key) => {
    for (const value of [undefined, "", " "]) {
      const environment = { ...deployedEnvironment(), [key]: value };
      const result = parseRuntimeConfiguration(environment);
      expect(result.success).toBe(false);
      expect(JSON.stringify(result)).not.toContain("test-synthetic-provider-key");
      expect(JSON.stringify(result)).not.toContain("example");
    }
  });

  it("rejects wrong targets, connection overrides and missing transport protection", () => {
    const environment = deployedEnvironment();
    for (const databaseUrl of [
      environment.DATABASE_URL.replace("/trial?", "/other?"),
      environment.DATABASE_URL + "&host=other.example.test",
      environment.DATABASE_URL.replace("sslmode=require", "sslmode=disable"),
      "not-a-database-url", "https://db.example/trial",
    ]) expect(parseRuntimeConfiguration({ ...environment, DATABASE_URL: databaseUrl }).success).toBe(false);
    expect(parseRuntimeConfiguration({ ...environment, PITCHROOM_DATABASE_TARGET: "db.example:5432/other" }).success).toBe(false);
  });

  it("refuses unsupported providers and lookalike, credential-bearing or alternate endpoints", () => {
    const environment = deployedEnvironment();
    expect(parseRuntimeConfiguration({ ...environment, PITCHROOM_PROVIDER: "other" }).success).toBe(false);
    for (const baseURL of ["http://api.openai.com/v1", "https://api.openai.com.evil.test/v1", "https://api.openai.com/v1?forward=evil", "https://user:secret@api.openai.com/v1", "https://api.openai.com/other", "https://api.deepseek.com"]) {
      expect(parseRuntimeConfiguration({ ...environment, OPENAI_BASE_URL: baseURL }).success).toBe(false);
    }
    expect(parseRuntimeConfiguration({ ...environment, PITCHROOM_PROVIDER: "deepseek", OPENAI_BASE_URL: "https://api.deepseek.com" }).success).toBe(true);
    expect(parseRuntimeConfiguration({ ...environment, NODE_ENV: "development", PITCHROOM_DEPLOYMENT_ENV: "local", PITCHROOM_PROVIDER: "deepseek", OPENAI_BASE_URL: undefined }).success).toBe(false);
  });

  it("makes worker runtime follow the same configuration and refuses conflicting flags", () => {
    const environment = deployedEnvironment();
    expect(parseRuntimeConfiguration(environment, { component: "worker" })).toEqual(parseRuntimeConfiguration(environment));
    expect(parseRuntimeConfiguration({ PITCHROOM_RUNTIME: "postgres-fake", DATABASE_URL: "postgres://localhost/synthetic" }, { component: "worker", liveFlag: true }).success).toBe(false);
    expect(parseRuntimeConfiguration({ PITCHROOM_RUNTIME: "fixture" }, { component: "worker" }).success).toBe(false);
    expect(parseRuntimeConfiguration({ DATABASE_URL: "postgres://localhost/synthetic" }, { component: "worker" })).toMatchObject({ success: true, config: { runtime: { mode: "postgres-fake" } } });
  });

  it("reports only non-secret declarations, without claiming deployed readiness", () => {
    const result = parseRuntimeConfiguration(deployedEnvironment());
    expect(result.success).toBe(true);
    if (!result.success) throw new Error("Expected valid synthetic configuration");
    const summary = configurationSummary(result.config);
    expect(summary).toMatchObject({ environment: "trial", runtime: "live", deploymentReadiness: "unverified", releaseSha: "a".repeat(40) });
    for (const secret of ["example", "test-synthetic-provider-key", "trial_user", "db.example"]) expect(JSON.stringify(summary)).not.toContain(secret);
  });
});
