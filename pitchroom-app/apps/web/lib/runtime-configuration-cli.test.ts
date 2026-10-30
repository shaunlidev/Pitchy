import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { deployedEnvironment } from "../../../packages/domain/src/runtime-configuration.testkit";

const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function temporaryCwd(localEnv?: string) {
  const directory = mkdtempSync(join(tmpdir(), "pitchroom-pit34-"));
  directories.push(directory);
  if (localEnv !== undefined) {
    mkdirSync(join(directory, "apps/web"), { recursive: true });
    writeFileSync(join(directory, "apps/web/.env.local"), localEnv);
  }
  return directory;
}
function check(environment: Record<string, string>, args: string[] = [], cwd = temporaryCwd()) {
  return spawnSync(process.execPath, [join(appRoot, "scripts/check-env.mjs"), ...args], {
    cwd, env: { PATH: process.env.PATH, NODE_ENV: "test", ...environment }, encoding: "utf8", timeout: 10_000,
  });
}

describe("configuration CLI and worker entry", () => {
  it("refuses a production launch before starting a service and recovers with explicit local fixture identity", () => {
    const missing = check({}, ["--production"]);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("PITCHROOM_DEPLOYMENT_ENV");
    const repaired = check({ PITCHROOM_DEPLOYMENT_ENV: "local", PITCHROOM_RUNTIME: "fixture" }, ["--production"]);
    expect(repaired.status).toBe(0);
    expect(JSON.parse(repaired.stdout)).toMatchObject({ status: "CONFIGURATION_VALID", environment: "local", runtime: "fixture" });
  });

  it("does not fill production omissions from local env files", () => {
    const cwd = temporaryCwd(Object.entries(deployedEnvironment()).map(([key, value]) => `${key}=${value}`).join("\n"));
    expect(check({}, ["--production"], cwd).status).toBe(1);
    expect(check({ PITCHROOM_DEPLOYMENT_ENV: "trial" }, [], cwd).status).toBe(1);
  });

  it("preserves shell overrides, including invalid empty values, in local development", () => {
    const cwd = temporaryCwd("PITCHROOM_RUNTIME=fixture\nOPENAI_API_KEY=never-print-this-synthetic-value\n");
    expect(JSON.parse(check({}, [], cwd).stdout).runtime).toBe("fixture");
    const invalid = check({ PITCHROOM_RUNTIME: "" }, [], cwd);
    expect(invalid.status).toBe(1);
    expect(invalid.stdout + invalid.stderr).not.toContain("never-print-this-synthetic-value");
    expect(check({}, [], temporaryCwd("PITCHROOM_DEPLOYMENT_ENV=trial")).status).toBe(1);
  });

  it("reports complete declarations without credentials or a production PASS", () => {
    const result = check(deployedEnvironment());
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "CONFIGURATION_VALID", deploymentReadiness: "unverified" });
    expect(result.stdout + result.stderr).not.toMatch(/test-synthetic-provider-key|example/);
  });

  it("refuses the actual worker entry before DB access for a deployed fixture or conflicting live flag", () => {
    for (const runtime of ["fixture", "postgres-fake"]) {
      const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/clarification-worker.ts", "--once", "--live"], {
        cwd: appRoot, env: { PATH: process.env.PATH, NODE_ENV: "production", ...deployedEnvironment(), PITCHROOM_RUNTIME: runtime }, encoding: "utf8", timeout: 10_000,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Clarification worker failed.");
      expect(result.stdout + result.stderr).not.toMatch(/test-synthetic-provider-key|example/);
      expect(result.error).toBeUndefined();
    }
  });
});
