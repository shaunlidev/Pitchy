import { createDatabase, ClarificationRepository } from "../packages/persistence/src/index";
import { DeterministicClarificationRunner, createModelClarificationRunner, evaluateClarification, classifyClarificationFailure } from "../packages/agent/src/index";
import { parseRuntimeConfiguration } from "../packages/domain/src/runtime-configuration";

async function main() {
  if (process.argv.slice(2).some((flag) => !["--live", "--once"].includes(flag))) throw new Error("Unsupported worker option.");
  const configured = parseRuntimeConfiguration(process.env, { component: "worker", liveFlag: process.argv.includes("--live") });
  if (!configured.success || configured.config.runtime.mode === "fixture") throw new Error("Worker runtime configuration is invalid.");
  const runtime = configured.config.runtime;
  const live = runtime.mode === "live";
  const database = createDatabase(runtime.databaseUrl);
  const store = new ClarificationRepository(database.db);
  const runner = runtime.mode === "live" ? createModelClarificationRunner(runtime) : new DeterministicClarificationRunner();
  let stopping = false; process.on("SIGINT",()=>{stopping=true;}); process.on("SIGTERM",()=>{stopping=true;});
  try {
    do {
      const task = await store.claim(runtime.mode === "live" ? runtime.model : "deterministic-local", live ? "live" : "synthetic");
      if (task) {
        try { await store.finish(task,await evaluateClarification(task,runner)); }
        catch (error) { await store.finish(task,undefined,classifyClarificationFailure(error).code,classifyClarificationFailure(error)); }
      } else if (!process.argv.includes("--once")) await new Promise(resolve=>setTimeout(resolve,1000));
    } while (!stopping && !process.argv.includes("--once"));
  } finally { await database.client.end(); }
}
main().catch(()=>{process.stderr.write("Clarification worker failed. Check database readiness and worker configuration.\n");process.exitCode=1;});
