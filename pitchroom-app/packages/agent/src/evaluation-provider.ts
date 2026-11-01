import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { budgetedProviderFetch, inspectProviderBudget, ProviderBudgetError, type ProviderBudgetOperation } from "./provider-budget";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const evaluationProviderReferenceSchema = z.object({
  schemaVersion: z.literal(1), directory: z.string().refine(isAbsolute), policyHash: hash,
  sessionId: z.string().uuid(), instanceId: z.string().uuid(), sourceHash: hash, caseHash: hash,
}).strict();
const identitySchema = z.object({ instanceId: z.string().uuid(), sourceHash: hash, caseHash: hash });
type Environment = Readonly<Record<string, string | undefined>>;

function readReference(path: string) {
  if (!isAbsolute(path)) throw new ProviderBudgetError("BUDGET_REFERENCE_PATH");
  for (let current = resolve(path); ; current = dirname(current)) {
    if (lstatSync(current).isSymbolicLink()) throw new ProviderBudgetError("BUDGET_SYMLINK");
    if (current === dirname(current)) break;
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 4096) throw new ProviderBudgetError("BUDGET_REFERENCE_PATH");
  return evaluationProviderReferenceSchema.parse(JSON.parse(readFileSync(path, "utf8")));
}

function configuration(environment: Environment) {
  const values = [environment.PITCHROOM_EVAL_BUDGET_FILE, environment.PITCHROOM_EVAL_INSTANCE_ID, environment.PITCHROOM_EVAL_SOURCE_HASH, environment.PITCHROOM_EVAL_CASE_HASH];
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => !value)) throw new ProviderBudgetError("BUDGET_EVALUATION_CONFIG");
  const identity = identitySchema.parse({ instanceId: environment.PITCHROOM_EVAL_INSTANCE_ID, sourceHash: environment.PITCHROOM_EVAL_SOURCE_HASH, caseHash: environment.PITCHROOM_EVAL_CASE_HASH });
  const reference = readReference(z.string().parse(environment.PITCHROOM_EVAL_BUDGET_FILE));
  if (reference.instanceId !== identity.instanceId || reference.sourceHash !== identity.sourceHash || reference.caseHash !== identity.caseHash) throw new ProviderBudgetError("BUDGET_REFERENCE_MISMATCH");
  const { policy } = inspectProviderBudget(reference.directory, reference.policyHash);
  const endpoint = `${(environment.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
  if (environment.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized" || !environment.OPENAI_API_KEY || environment.OPENAI_MODEL !== policy.model || endpoint !== policy.endpoint || identity.sourceHash !== policy.sourceHash || identity.caseHash !== policy.caseHash) throw new ProviderBudgetError("BUDGET_BINDING_MISMATCH");
  return { reference, identity, policy };
}

export function evaluationProviderProjectId(environment: Environment): string | undefined {
  const configured = configuration(environment);
  return configured ? z.string().uuid().parse(configured.policy.projectId) : undefined;
}

/** Only an explicit local evaluation reference can attach a cumulative budget. This does not grant model permission. */
export function evaluationProviderFetch(input: {
  environment: Environment; projectId: string; stage: ProviderBudgetOperation["stage"]; commandId: string; transport: typeof fetch;
}): typeof fetch | undefined {
  const configured = configuration(input.environment);
  if (!configured) return undefined;
  const { reference, identity, policy } = configured;
  if (input.projectId !== policy.projectId) throw new ProviderBudgetError("BUDGET_BINDING_MISMATCH");
  return budgetedProviderFetch({ directory: reference.directory, policyHash: reference.policyHash, transport: input.transport,
    operation: { acceptanceId: policy.acceptanceId, sessionId: reference.sessionId, projectId: input.projectId,
      sourceHash: identity.sourceHash, caseHash: identity.caseHash, stage: input.stage, commandId: input.commandId } });
}
