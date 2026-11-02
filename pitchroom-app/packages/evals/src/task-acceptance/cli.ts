import { auditProviderBudget } from "./provider-budget-audit";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { z } from "zod";
import { assertUnlinkedPath } from "./capacity";
import { advance, audit, prepare, recordDecision, report } from "./workflow";
import { issueReviewPacket, recordReviewEvidence } from "./review";
import { assessTask } from "./verdict";

const help = `Task acceptance workflow (isolated HTTP; no semantic or user acceptance implied)

prepare --case DIR --launch-receipt FILE --accounting-policy FILE --source-repository DIR
        --session-id UUID --maximum-bytes INTEGER --purpose tool_validation|task_evidence
advance --run FILE
record-decision --run FILE --file DECISION.json
audit --run FILE
report --run FILE
review-packet --run FILE --checkpoint HASH --actor ID
review-record --run FILE --file RECORD.json
assess --run FILE
provider-budget-audit --budget-directory ABSOLUTE --policy-hash SHA256

No arguments or --help prints this help without preparing or dispatching work.
prepare is local only. advance stops at the next human boundary and never Applies or Accepts.
record-decision requires actor, time, checkpointHash, capability, assistance and an explicit response.
An awaiting_human result includes exact displayed choices and the actual product workspace.
Live runtime/provider dispatch is unavailable here; frozen inputs do not authorize it.
`;
const commandSchema = z.enum(["prepare", "advance", "record-decision", "audit", "report", "review-packet", "review-record", "assess", "provider-budget-audit"]);
const prepareOptions = ["case", "launch-receipt", "accounting-policy", "source-repository", "session-id", "maximum-bytes", "purpose"];
const commandOptions = { prepare: prepareOptions, advance: ["run"], "record-decision": ["run", "file"], audit: ["run"], report: ["run"], "review-packet": ["run", "checkpoint", "actor"], "review-record": ["run", "file"], assess: ["run"], "provider-budget-audit": ["budget-directory", "policy-hash"] };

function decisionFile(path: string): unknown {
  assertUnlinkedPath(path);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 1_100_000) throw new Error("TASK_DECISION_FILE_LIMIT");
  return JSON.parse(readFileSync(path, "utf8"));
}
export async function runTaskAcceptanceCLI(args: string[], output: (value: string) => void = value => process.stdout.write(value)): Promise<number> {
  let command: z.infer<typeof commandSchema> | undefined;
  try {
    if (!args.length || args.includes("--help")) { output(help); return 0; }
    const parsed = parseArgs({ args, allowPositionals: true, strict: true, options: {
      "budget-directory": { type: "string" }, "policy-hash": { type: "string" }, case: { type: "string" }, "launch-receipt": { type: "string" }, "accounting-policy": { type: "string" }, "source-repository": { type: "string" },
      "session-id": { type: "string" }, "maximum-bytes": { type: "string" }, purpose: { type: "string" }, run: { type: "string" }, file: { type: "string" }, checkpoint: { type: "string" }, actor: { type: "string" },
    } });
    if (parsed.positionals.length !== 1) throw new Error("TASK_COMMAND_REQUIRED");
    const selected = commandSchema.parse(parsed.positionals[0]); command = selected;
    const values = z.record(z.string(), z.string()).parse(parsed.values);
    if (Object.keys(values).some(key => !commandOptions[selected].includes(key))) throw new Error("TASK_OPTION_SCOPE");
    for (const key of commandOptions[selected]) if (!values[key]) throw new Error("TASK_OPTION_REQUIRED");
    const path = (name: string) => resolve(z.string().min(1).parse(values[name]));
    let result: unknown;
    switch (command) {
      case "prepare": {
        const number = z.string().regex(/^[1-9][0-9]*$/).parse(parsed.values["maximum-bytes"]);
        result = prepare({ caseDirectory: path("case"), accountingPolicyFile: path("accounting-policy"), launchReceiptFile: path("launch-receipt"), sourceRepository: path("source-repository"), sessionId: parsed.values["session-id"], maximumBytes: Number(number), purpose: parsed.values.purpose }); break;
      }
      case "advance": result = await advance({ referenceFile: path("run") }); break;
      case "record-decision": result = await recordDecision({ run: { referenceFile: path("run") }, decision: decisionFile(path("file")) }); break;
      case "audit": result = audit({ referenceFile: path("run") }); break;
      case "report": result = report({ referenceFile: path("run") }); break;
      case "provider-budget-audit": result = auditProviderBudget({ directory: values["budget-directory"], policyHash: values["policy-hash"] }); break;
      case "assess": result = assessTask({ referenceFile: path("run") }); break;
      case "review-packet": result = issueReviewPacket({ referenceFile: path("run") }, { checkpointHash: values.checkpoint, actorId: values.actor }); break;
      case "review-record": result = recordReviewEvidence({ referenceFile: path("run") }, decisionFile(path("file"))); break;
      default: { const exhaustive: never = command; return exhaustive; }
    }
    output(`${JSON.stringify({ command, result })}\n`);
    if (z.object({ kind: z.literal("assessment_unavailable") }).safeParse(result).success) return 1;
    return z.object({ kind: z.literal("held") }).safeParse(result).success ? 2 : 0;
  } catch (error) {
    const candidate = z.object({ code: z.string() }).safeParse(error).data?.code ?? (error instanceof Error ? error.message : "");
    const code = /^[A-Z][A-Z0-9_]{0,100}$/.test(candidate) ? candidate : "TASK_COMMAND_FAILED";
    output(`${JSON.stringify({ command: command ?? null, errorCode: code })}\n`); return 1;
  }
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === fileURLToPath(import.meta.url)) process.exitCode = await runTaskAcceptanceCLI(process.argv.slice(2));
