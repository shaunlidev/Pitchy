import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseRuntimeConfiguration } from "@pitchroom/domain";
import { deployedEnvironment } from "../../domain/src/runtime-configuration.testkit";
import { deploymentSchemaVersion, readinessExpectation, releaseMigrations } from "./deployment-readiness";

describe("release migration identity", () => {
  it("pins the exact checked-in SQL and ordered journal used by the actual migrator", () => {
    const root = new URL("../migrations/", import.meta.url);
    const journal = JSON.parse(readFileSync(new URL("meta/_journal.json", root), "utf8")) as { entries: { tag: string; when: number }[] };
    const actual = journal.entries.map(entry => ({ hash: createHash("sha256").update(readFileSync(new URL(`${entry.tag}.sql`, root))).digest("hex"), createdAt: entry.when }));
    expect(releaseMigrations).toEqual(actual);
    expect(deploymentSchemaVersion).toBe(createHash("sha256").update(JSON.stringify(actual)).digest("hex"));
  });
  it("binds non-secret worker configuration and excludes credentials", () => {
    const expectation = (env: Record<string, string>) => {
      const result = parseRuntimeConfiguration(env);
      if (!result.success) throw new Error("Invalid test configuration");
      return readinessExpectation(result.config);
    };
    const env = { ...deployedEnvironment(), PITCHROOM_SCHEMA_VERSION: deploymentSchemaVersion };
    const baseline = expectation(env);
    expect(baseline.databaseName).toBe("trial");
    expect(baseline.migrationVersion).toBe(deploymentSchemaVersion);
    expect(expectation({ ...env, OPENAI_API_KEY: "test-other-secret" }).configurationHash).toBe(baseline.configurationHash);
    for (const key of ["OPENAI_MODEL", "PITCHROOM_BUDGET_ID", "PITCHROOM_TRANSFER_APPROVAL_ID"]) expect(expectation({ ...env, [key]: "other-value" }).configurationHash).not.toBe(baseline.configurationHash);
    expect(JSON.stringify(baseline)).not.toMatch(/test-synthetic-provider-key|postgres:\/\//);
  });
});
