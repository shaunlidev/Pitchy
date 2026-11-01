import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";
import { assertProviderBudgetResumable, budgetedProviderFetch, inspectProviderBudget, ProviderBudgetError, type ProviderBudgetOperation } from "./provider-budget";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const evaluationProviderReferenceSchema = z.object({
  schemaVersion: z.literal(1), directory: z.string().refine(isAbsolute), policyHash: hash,
  sessionId: z.string().uuid(), instanceId: z.string().uuid(), sourceHash: hash, caseHash: hash, targetFingerprint: hash,
}).strict();
const identitySchema = z.object({ instanceId: z.string().uuid(), sourceHash: hash, caseHash: hash });
type Environment = Readonly<Record<string, string | undefined>>;
export const evaluationProviderKeys = ["PITCHROOM_EVAL_BUDGET_FILE", "PITCHROOM_EVAL_INSTANCE_ID", "PITCHROOM_EVAL_SOURCE_HASH", "PITCHROOM_EVAL_CASE_HASH", "PITCHROOM_EVAL_REFERENCE_HASH"] as const;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function evaluationProviderReferenceHash(raw: unknown) {
  return digest(JSON.stringify(evaluationProviderReferenceSchema.parse(raw)));
}
export function evaluationProviderTargetFingerprint(databaseURL: string | undefined) {
  const url = new URL(databaseURL ?? "");
  if (!["postgres:", "postgresql:"].includes(url.protocol) || url.hostname !== "127.0.0.1" || !url.port || !/^\/pit55_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) throw new ProviderBudgetError("BUDGET_DATABASE_TARGET");
  return digest(`${url.protocol}//${url.hostname}:${url.port}${url.pathname}`);
}

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
  const values = evaluationProviderKeys.map(key => environment[key]);
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => !value)) throw new ProviderBudgetError("BUDGET_EVALUATION_CONFIG");
  const identity = identitySchema.parse({ instanceId: environment.PITCHROOM_EVAL_INSTANCE_ID, sourceHash: environment.PITCHROOM_EVAL_SOURCE_HASH, caseHash: environment.PITCHROOM_EVAL_CASE_HASH });
  const reference = readReference(z.string().parse(environment.PITCHROOM_EVAL_BUDGET_FILE));
  const referenceHash = evaluationProviderReferenceHash(reference);
  if (referenceHash !== environment.PITCHROOM_EVAL_REFERENCE_HASH) throw new ProviderBudgetError("BUDGET_REFERENCE_CHANGED");
  if (reference.instanceId !== identity.instanceId || reference.sourceHash !== identity.sourceHash || reference.caseHash !== identity.caseHash) throw new ProviderBudgetError("BUDGET_REFERENCE_MISMATCH");
  if (evaluationProviderTargetFingerprint(environment.DATABASE_URL) !== reference.targetFingerprint) throw new ProviderBudgetError("BUDGET_DATABASE_TARGET");
  const { policy } = inspectProviderBudget(reference.directory, reference.policyHash);
  const endpoint = `${(environment.OPENAI_BASE_URL ?? "https://api.openai.com/v1").replace(/\/+$/, "")}/responses`;
  if (environment.PITCHROOM_LIVE_TRANSFER_ACK !== "authorized" || !environment.OPENAI_API_KEY || environment.OPENAI_MODEL !== policy.model || endpoint !== policy.endpoint || identity.sourceHash !== policy.sourceHash || identity.caseHash !== policy.caseHash) throw new ProviderBudgetError("BUDGET_BINDING_MISMATCH");
  return { reference, referenceHash, identity, policy };
}

/** Operator-owned launch binding; neither formal task acceptance nor proof of consent. */
export function evaluationProviderIdentity(environment: Environment, pid = process.pid) {
  const configured = configuration(environment);
  if (!configured) return undefined;
  const { reference, referenceHash, policy } = configured;
  return { kind: "isolated_budget_evaluation" as const, runtime: "live" as const, pid,
    instanceId: reference.instanceId, sourceFingerprint: reference.sourceHash, targetFingerprint: reference.targetFingerprint,
    sessionId: reference.sessionId, acceptanceId: policy.acceptanceId, policyHash: reference.policyHash,
    caseHash: reference.caseHash, projectId: z.string().uuid().parse(policy.projectId), referenceHash };
}

export function evaluationProviderProjectId(environment: Environment): string | undefined {
  const configured = configuration(environment);
  if (configured) assertProviderBudgetResumable(configured.reference.directory, configured.reference.policyHash);
  return configured ? z.string().uuid().parse(configured.policy.projectId) : undefined;
}

/** Only an explicit local evaluation reference can attach a cumulative budget. This does not grant model permission. */
export function evaluationProviderFetch(input: {
  environment: Environment; projectId: string; stage: ProviderBudgetOperation["stage"]; commandId: string; transport: typeof fetch;
  workerAttempt?: ProviderBudgetOperation["workerAttempt"];
}): typeof fetch | undefined {
  const configured = configuration(input.environment);
  if (!configured) return undefined;
  const { reference, identity, policy } = configured;
  if (input.projectId !== policy.projectId) throw new ProviderBudgetError("BUDGET_BINDING_MISMATCH");
  if (input.stage === "clarify" && !input.workerAttempt) throw new ProviderBudgetError("BUDGET_WORKER_ATTEMPT");
  return budgetedProviderFetch({ directory: reference.directory, policyHash: reference.policyHash, transport: input.transport,
    operation: { acceptanceId: policy.acceptanceId, sessionId: reference.sessionId, projectId: input.projectId,
      sourceHash: identity.sourceHash, caseHash: identity.caseHash, stage: input.stage, commandId: input.commandId, workerAttempt: input.workerAttempt } });
}
