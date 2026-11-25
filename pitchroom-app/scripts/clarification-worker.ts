import { createDatabase, ClarificationRepository, openDeploymentReadiness, readinessExpectation } from "../packages/persistence/src/index";
import { ProviderBudgetError, evaluationProviderFetch, evaluationProviderProjectId, DeterministicClarificationRunner, createModelClarificationRunner, evaluateClarification, classifyClarificationFailure } from "../packages/agent/src/index";
import { parseRuntimeConfiguration } from "../packages/domain/src/runtime-configuration";
import { startWorkerReadiness } from "./worker-readiness";

async function main() {
  if (process.argv.slice(2).some((flag) => !["--live", "--once"].includes(flag))) throw new Error("Unsupported worker option.");
  const configured = parseRuntimeConfiguration(process.env, { component: "worker", liveFlag: process.argv.includes("--live") });
  if (!configured.success || configured.config.runtime.mode === "fixture") throw new Error("Worker runtime configuration is invalid.");
  const runtime = configured.config.runtime;
  const live = runtime.mode === "live";
  const evaluationProjectId = live ? evaluationProviderProjectId(process.env) : undefined;
  const database = createDatabase(runtime.databaseUrl);
  const store = new ClarificationRepository(database.db);
  let readiness: Awaited<ReturnType<typeof startWorkerReadiness>> | undefined;
  let stopping = false;
  const stop = () => { stopping = true; void readiness?.stop().catch(() => {}); };
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    if (configured.config.deployment.kind === "deployed") {
      const expected = readinessExpectation(configured.config);
      const connection = openDeploymentReadiness(runtime.databaseUrl);
      readiness = await startWorkerReadiness({ pulse: instanceId => connection.pulse(expected, instanceId), stop: connection.stop, close: connection.close });
    }
    if (stopping) return;
    do {
      if ((readiness && !(await readiness.beforeClaim())) || stopping) break;
      if (live) {
        try { if (evaluationProviderProjectId(process.env) !== evaluationProjectId) throw new Error("Evaluation project changed during worker execution."); }
        catch (error) {
          if (error instanceof ProviderBudgetError && error.code === "BUDGET_BUSY" && !process.argv.includes("--once")) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
          throw error;
        }
      }
      const task = await store.claim(runtime.mode === "live" ? runtime.model : "deterministic-local", live ? "live" : "synthetic", evaluationProjectId);
      if (task) {
        try {
          const attempt = task.attempts.at(-1);
          if (!attempt || attempt.status !== "running") throw new Error("Claimed clarification has no running attempt.");
          const runner = runtime.mode === "live" ? createModelClarificationRunner({
            ...runtime,
            fetch: evaluationProviderFetch({ environment: process.env, projectId: task.projectId, stage: "clarify", commandId: attempt.commandId, workerAttempt: { taskId: task.id, attemptId: attempt.id }, transport: fetch }),
          }) : new DeterministicClarificationRunner();
          await store.finish(task,await evaluateClarification(task,runner));
        }
        catch (error) { await store.finish(task,undefined,classifyClarificationFailure(error).code,classifyClarificationFailure(error)); }
      } else if (!process.argv.includes("--once")) await new Promise(resolve=>setTimeout(resolve,1000));
    } while (!stopping && !process.argv.includes("--once"));
  } finally {
    process.off("SIGINT", stop); process.off("SIGTERM", stop);
    try { await readiness?.stop(); } finally { await database.client.end({ timeout: 1 }); }
  }
}
main().catch(()=>{process.stderr.write("Clarification worker failed. Check database readiness and worker configuration.\n");process.exitCode=1;});
