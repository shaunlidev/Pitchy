import { readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export function isDedicatedIntegrationTarget(value) {
  try {
    const url = new URL(value);
    return ["postgres:", "postgresql:"].includes(url.protocol)
      && ["127.0.0.1", "localhost"].includes(url.hostname)
      && url.port === "55437" && url.username === "clarify_qa"
      && url.pathname === "/clarify_qa" && !url.search && !url.hash;
  } catch { return false; }
}

export function runPersistenceTests(env = process.env) {
  if (!isDedicatedIntegrationTarget(env.DATABASE_URL)) {
    console.error("Integration checks require the dedicated clarify_qa user/database on localhost:55437. No environment file is loaded; set DATABASE_URL explicitly. No database action was started.");
    return 1;
  }
  const directory = resolve(dirname(fileURLToPath(import.meta.url)), "../packages/persistence");
  const suites = readdirSync(resolve(directory, "src")).filter(name => name.endsWith(".integration.test.ts")).sort().map(name => `src/${name}`);
  if (!suites.length) {
    console.error("No persistence integration suites were found; this is not a passing check.");
    return 1;
  }
  console.log(`Running ${suites.length} integration suites serially against the dedicated local QA database.`);
  const result = spawnSync("pnpm", ["exec", "vitest", "run", "--no-file-parallelism", ...suites], { cwd: directory, env, stdio: "inherit" });
  if (result.error) { console.error("The persistence test process could not start."); return 1; }
  return result.status ?? 1;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = runPersistenceTests();
