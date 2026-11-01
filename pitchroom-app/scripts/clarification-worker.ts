import { createDatabase, ClarificationRepository } from "../packages/persistence/src/index";
import { evaluationProviderFetch, evaluationProviderProjectId, DeterministicClarificationRunner, createModelClarificationRunner, evaluateClarification, classifyClarificationFailure } from "../packages/agent/src/index";

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
      const task = await store.claim(live ? process.env.OPENAI_MODEL! : "deterministic-local", live ? "live" : "synthetic", evaluationProjectId);
      if (task) {
        try {
          const runner = live ? createModelClarificationRunner({ apiKey:process.env.OPENAI_API_KEY!,baseURL:process.env.OPENAI_BASE_URL,model:process.env.OPENAI_MODEL!,fetch:evaluationProviderFetch({environment:process.env,projectId:task.projectId,stage:"clarify",commandId:task.commandId,transport:fetch}) }) : new DeterministicClarificationRunner();
          await store.finish(task,await evaluateClarification(task,runner));
        }
        catch (error) { await store.finish(task,undefined,classifyClarificationFailure(error).code,classifyClarificationFailure(error)); }
      } else if (!process.argv.includes("--once")) await new Promise(resolve=>setTimeout(resolve,1000));
    } while (!stopping && !process.argv.includes("--once"));
  } finally { await database.client.end(); }
}
main().catch(()=>{process.stderr.write("Clarification worker failed. Check database readiness and worker configuration.\n");process.exitCode=1;});
