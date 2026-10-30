import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { runTaskAcceptanceCLI } from "./cli";

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function call(args: string[]) {
  const output: string[] = [];
  const code = await runTaskAcceptanceCLI(args, text => output.push(text));
  return { code, output: output.join("") };
}
it("defaults to help with no dispatch, including help alongside non-executed options", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  expect(await call([])).toMatchObject({ code: 0 });
  expect((await call(["--help", "--run", "/does-not-exist"])).output).toContain("prepare is local only");
  expect(fetch).not.toHaveBeenCalled();
});
it("rejects missing, cross-command and unknown options instead of discovering a default target", async () => {
  expect(await call(["advance"])).toMatchObject({ code: 1 });
  expect(await call(["advance", "--run", "/missing.json", "--case", "/wrong"])).toMatchObject({ code: 1 });
  const result = await call(["advance", "--api-key=synthetic-secret-must-not-be-printed"]);
  expect(result.code).toBe(1); expect(result.output).not.toContain("synthetic-secret-must-not-be-printed");
  expect(JSON.parse(result.output).errorCode).toBe("ERR_PARSE_ARGS_UNKNOWN_OPTION");
});
it("does not echo malformed decision contents in its error output", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit53-cli-error-"))); roots.push(root);
  const path = join(root, "decision.json"); writeFileSync(path, "not-json synthetic-secret-must-not-be-printed");
  const result = await call(["record-decision", "--run", join(root, "run.json"), "--file", path]);
  expect(result.code).toBe(1); expect(result.output).not.toContain("synthetic-secret-must-not-be-printed");
});
it("prepares explicit inputs and audits/reports the same local run without HTTP", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit53-cli-local-"))); roots.push(root);
  for (const path of ["pitchroom-v6/evidence", "history", "pitchroom-app/.artifacts"]) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, "pitchroom-v6/manifest.json"), JSON.stringify({ evidencePolicy: { approvedCapBytes: 3_000_000, accountingPackageRoots: ["evidence"], accountingWorkspaceRoots: [{ path: "history", required: true }] } }));
  const policy = join(root, "policy.json"), launch = join(root, "launch.json");
  writeFileSync(policy, JSON.stringify({ repositoryRoot: root, recordDirectory: "pitchroom-app/.artifacts/workflow", referenceLinks: [], legacyWriters: "quiescent" }));
  writeFileSync(launch, JSON.stringify({ baseURL: "http://127.0.0.1:3153/", instance: { kind: "isolated_evaluation_instance", instanceId: randomUUID(), sourceFingerprint: "a".repeat(64), targetFingerprint: "b".repeat(64), runtime: "fixture", projectSelector: "atelier", pid: process.pid }, projectId: "00000000-0000-4000-8000-000000000001", timeoutMs: 1000, maximumResponseBytes: 1_000_000 }));
  const repository = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: fileURLToPath(new URL(".", import.meta.url)), encoding: "utf8" }).trim();
  const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network"));
  const prepared = await call(["prepare", "--case", fileURLToPath(new URL("../../config/task-acceptance/pitchroom-r1/", import.meta.url)), "--launch-receipt", launch, "--accounting-policy", policy, "--source-repository", repository, "--session-id", randomUUID(), "--maximum-bytes", "1000000", "--purpose", "tool_validation"]);
  expect(prepared.code).toBe(0);
  const run = z.object({ result: z.object({ referenceFile: z.string() }) }).parse(JSON.parse(prepared.output)).result;
  const before = readFileSync(run.referenceFile);
  for (const command of ["audit", "report"]) {
    const result = await call([command, "--run", run.referenceFile]); expect(result.code).toBe(0);
    expect(JSON.parse(result.output).result).toMatchObject({ execution: "prepared", semantic: "not_evaluated", userTask: "not_observed" });
  }
  expect(readFileSync(run.referenceFile)).toEqual(before); expect(fetch).not.toHaveBeenCalled();
});
it("loads through native Node/tsx and defaults to help without env-file, credential or HTTP access", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit53-cli-native-"))); roots.push(root);
  writeFileSync(join(root, ".env.local"), "OPENAI_API_KEY=test-never-read\n");
  const code = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
    const original=fs.readFileSync; fs.readFileSync=function(path,...args){if(String(path).endsWith('/.env.local'))throw Error('Unexpected environment-file read');return original.call(this,path,...args);}; syncBuiltinESMExports();
    const environment=process.env; process.env=new Proxy(environment,{get(target,key){if(['OPENAI_API_KEY','DEEPSEEK_API_KEY','ANTHROPIC_API_KEY'].includes(key))throw Error('Unexpected credential read');return Reflect.get(target,key);}});
    globalThis.fetch=()=>{throw Error('Unexpected HTTP');};
    const {runTaskAcceptanceCLI}=await import(${JSON.stringify(new URL("./cli.ts", import.meta.url).href)}); process.exitCode=await runTaskAcceptanceCLI([]);`;
  const result = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), "--input-type=module", "-e", code], { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 10000 });
  expect(result.status, result.stderr).toBe(0); expect(result.stdout).toContain("prepare is local only");
});
