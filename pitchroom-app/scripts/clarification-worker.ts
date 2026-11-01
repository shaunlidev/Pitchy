import { createDatabase, ClarificationRepository } from "../packages/persistence/src/index";
import { ProviderBudgetError, evaluationProviderFetch, evaluationProviderProjectId, DeterministicClarificationRunner, createModelClarificationRunner, evaluateClarification, classifyClarificationFailure } from "../packages/agent/src/index";

async function main() {
  const live = process.argv.includes("--live");
  if (live && (process.env.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized" || !process.env.OPENAI_API_KEY || !process.env.OPENAI_MODEL)) throw new Error("Live worker requires explicit transfer acknowledgement, key and pinned model.");
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required. Worker environment must be supplied explicitly.");
  const evaluationProjectId = live ? evaluationProviderProjectId(process.env) : undefined;
  const database = createDatabase(process.env.DATABASE_URL);
  const store = new ClarificationRepository(database.db);
  let stopping = false; process.on("SIGINT",()=>{stopping=true;}); process.on("SIGTERM",()=>{stopping=true;});
  try {
    do {
      if (live) {
        try { if (evaluationProviderProjectId(process.env) !== evaluationProjectId) throw new Error("Evaluation project changed during worker execution."); }
        catch (error) {
          if (error instanceof ProviderBudgetError && error.code === "BUDGET_BUSY" && !process.argv.includes("--once")) { await new Promise(resolve => setTimeout(resolve, 1000)); continue; }
          throw error;
        }
      }
      const task = await store.claim(live ? process.env.OPENAI_MODEL! : "deterministic-local", live ? "live" : "synthetic", evaluationProjectId);
      if (task) {
        try {
          const attempt = task.attempts.at(-1);
          if (!attempt || attempt.status !== "running") throw new Error("Claimed clarification has no running attempt.");
          const runner = live ? createModelClarificationRunner({ apiKey:process.env.OPENAI_API_KEY!,baseURL:process.env.OPENAI_BASE_URL,model:process.env.OPENAI_MODEL!,fetch:evaluationProviderFetch({environment:process.env,projectId:task.projectId,stage:"clarify",commandId:attempt.commandId,workerAttempt:{taskId:task.id,attemptId:attempt.id},transport:fetch}) }) : new DeterministicClarificationRunner();
          await store.finish(task,await evaluateClarification(task,runner));
        }
        catch (error) { await store.finish(task,undefined,classifyClarificationFailure(error).code,classifyClarificationFailure(error)); }
      } else if (!process.argv.includes("--once")) await new Promise(resolve=>setTimeout(resolve,1000));
    } while (!stopping && !process.argv.includes("--once"));
  } finally { await database.client.end(); }
}
main().catch(()=>{process.stderr.write("Clarification worker failed. Check database readiness and worker configuration.\n");process.exitCode=1;});
