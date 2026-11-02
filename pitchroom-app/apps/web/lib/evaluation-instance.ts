import { createHash } from "node:crypto";
import { z } from "zod";

import { evaluationInstanceSchema, type EvaluationInstance } from "@pitchroom/domain";
import { evaluationProviderIdentity, evaluationProviderKeys } from "@pitchroom/agent";
const configurationSchema = z.object({
  instanceId: z.string().uuid(), sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  runtime: z.enum(["fixture", "postgres-fake"]),
}).strict();
type InstanceConfiguration =
  | { kind: "disabled" }
  | { kind: "invalid" }
  | { kind: "budgeted_live"; identity: NonNullable<ReturnType<typeof evaluationProviderIdentity>> }
  | { kind: "enabled"; identity: EvaluationInstance };

// An accidental-target safeguard for operator-owned local processes, not authentication.
export function evaluationInstance(environment: Readonly<Record<string, string | undefined>> = process.env, pid = process.pid): InstanceConfiguration {
  if (evaluationProviderKeys.every(key => environment[key] === undefined)) return { kind: "disabled" };
  if (environment.PITCHROOM_RUNTIME === "live") {
    try {
      const identity = evaluationProviderIdentity(environment, pid);
      return identity ? { kind: "budgeted_live", identity } : { kind: "invalid" };
    } catch { return { kind: "invalid" }; }
  }
  if (environment.PITCHROOM_EVAL_BUDGET_FILE !== undefined || environment.PITCHROOM_EVAL_CASE_HASH !== undefined || environment.PITCHROOM_EVAL_REFERENCE_HASH !== undefined) return { kind: "invalid" };
  const parsed = configurationSchema.safeParse({ instanceId: environment.PITCHROOM_EVAL_INSTANCE_ID, sourceFingerprint: environment.PITCHROOM_EVAL_SOURCE_HASH, runtime: environment.PITCHROOM_RUNTIME });
  if (!parsed.success) return { kind: "invalid" };
  let target = `fixture-process:${pid}`;
  if (parsed.data.runtime === "postgres-fake") {
    try {
      const url = new URL(environment.DATABASE_URL ?? "");
      if (!(["postgres:", "postgresql:"].includes(url.protocol)) || url.hostname !== "127.0.0.1" || !url.port || !/^\/pit52_[a-f0-9]{32}$/.test(url.pathname) || url.search || url.hash) return { kind: "invalid" };
      target = `${url.protocol}//${url.hostname}:${url.port}${url.pathname}`;
    } catch { return { kind: "invalid" }; }
  }
  const identity = evaluationInstanceSchema.safeParse({
    kind: "isolated_evaluation_instance", ...parsed.data,
    targetFingerprint: createHash("sha256").update(target).digest("hex"),
    projectSelector: "atelier", pid,
  });
  return identity.success ? { kind: "enabled", identity: identity.data } : { kind: "invalid" };
}

export function evaluationRequestGuard(request?: Request): Response | undefined {
  const configured = evaluationInstance();
  if (configured.kind === "invalid") return Response.json({ code: "INVALID_EVALUATION_INSTANCE", error: "Evaluation instance configuration is invalid." }, { status: 503 });
  const requested = request?.headers.get("x-pitchroom-eval-instance");
  if (configured.kind === "disabled") {
    if (requested !== undefined && requested !== null) return Response.json({ code: "EVALUATION_INSTANCE_MISMATCH", error: "This is not the requested evaluation instance." }, { status: 409 });
    return;
  }
  if (requested !== configured.identity.instanceId || request?.headers.get("x-pitchroom-eval-source") !== configured.identity.sourceFingerprint || request?.headers.get("x-pitchroom-eval-target") !== configured.identity.targetFingerprint) {
    return Response.json({ code: "EVALUATION_INSTANCE_MISMATCH", error: "Evaluation launch identity does not match." }, { status: 409 });
  }
  if (configured.kind === "budgeted_live" && request?.headers.get("x-pitchroom-eval-budget") !== configured.identity.referenceHash) return Response.json({ code: "EVALUATION_BUDGET_MISMATCH", error: "Evaluation budget launch binding does not match." }, { status: 409 });
}
