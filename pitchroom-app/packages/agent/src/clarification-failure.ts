import { NoObjectGeneratedError } from "ai";
import { z } from "zod";
import { ClarificationValidationError, PitchroomError, type ClarificationFailureDiagnostic } from "@pitchroom/domain";

export class ClarificationFailure extends Error {
  constructor(readonly diagnostic: ClarificationFailureDiagnostic) {
    super(diagnostic.code);
    this.name = "ClarificationFailure";
  }
}
function safeExcerpt(text: string, position: number, secrets: readonly string[]): string {
  // Never emit model thoughts or arbitrary provider messages as diagnostics.
  if (/<think\b|reasoning[_\s-]*(?:content|text)|chain[_\s-]*of[_\s-]*thought|"(?:thinking|reasoning)"\s*:/i.test(text)) return "[OMITTED: hidden-content marker]";
  let safe = text;
  for (const secret of secrets) if (secret) safe = safe.split(secret).join("[REDACTED]");
  safe = safe.replace(/\bsk-[a-zA-Z0-9_-]+/g, "[REDACTED]").replace(/Bearer\s+[^\s"'<>;,]+/gi, "Bearer [REDACTED]")
    .replace(/("(?:api[_-]?key|authorization|password|secret|access[_-]?token)"\s*:\s*")[^"\n]*(")/gi, "$1[REDACTED]$2");
  // Redaction can move offsets; returning the start is safer than exposing the
  // original bytes at a stale offset. This excerpt is diagnostic only.
  const at = safe === text ? position : 0;
  return safe.slice(Math.max(0, at - 70), at + 100).slice(0, 240);
}
function schemaIssues(error: unknown): ClarificationFailureDiagnostic["issues"] {
  let current: unknown = error;
  for (let i = 0; i < 6 && current && typeof current === "object"; i++) {
    if (current instanceof z.ZodError) return current.issues.slice(0, 12).map(issue => ({
      path: issue.path.map(p => typeof p === "number" ? String(p) : String(p).replace(/[^a-zA-Z0-9_]/g, "").slice(0, 30)).join(".").slice(0, 160), code: issue.code,
    }));
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}
export function classifyClarificationFailure(error: unknown, secrets: readonly string[] = []): ClarificationFailureDiagnostic {
  if (error instanceof ClarificationFailure || error instanceof ClarificationValidationError) return error.diagnostic;
  if (NoObjectGeneratedError.isInstance(error)) {
    if (error.finishReason === "length") return { stage: "provider", code: "OUTPUT_INCOMPLETE", providerStatus: "incomplete" };
    if (error.finishReason === "content-filter") return { stage: "provider", code: "OUTPUT_FILTERED" };
    if (typeof error.text === "string" && error.text.length) {
      try { JSON.parse(error.text); }
      catch (parseError) {
        const match = parseError instanceof Error ? /position (\d+)/.exec(parseError.message) : null;
        const position = match ? Number(match[1]) : error.text.length;
        return { stage: "syntax", code: "INVALID_JSON", position, excerpt: safeExcerpt(error.text, position, secrets) };
      }
      return { stage: "schema", code: "OUTPUT_SCHEMA_INVALID", issues: schemaIssues(error) };
    }
    return { stage: "provider", code: "NO_STRUCTURED_OUTPUT" };
  }
  if (error instanceof Error && error.message === "Clarification basis referenced quarantined source content.") return { stage: "reference", code: "QUARANTINED_SOURCE" };
  if (error instanceof z.ZodError) return { stage: "schema", code: "OUTPUT_SCHEMA_INVALID", issues: schemaIssues(error) };
  if (error instanceof PitchroomError) return { stage: "reference", code: "PROPOSAL_REJECTED" };
  const row = error as { name?: unknown; code?: unknown; statusCode?: unknown; message?: unknown } | undefined;
  if (row?.name === "ClarifyStop" && typeof row.code === "string") {
    const providerCodes = new Set(["MODEL_HTTP_ERROR", "MODEL_TRANSPORT_FAILED", "MISSING_USAGE", "PROVIDER_BOUND_MISMATCH", "TOKEN_COUNT_HTTP_ERROR", "TOKEN_COUNT_FAILED", "PROVIDER_INCOMPLETE", "PROVIDER_FAILED", "PROVIDER_REFUSAL"]);
    const budgetCodes = new Set(["COST_BUDGET", "INPUT_TOKEN_BUDGET", "OUTPUT_TOKEN_BUDGET", "STEP_BUDGET", "TOOL_CALL_BUDGET", "TOOL_CONTEXT_BUDGET", "TIME_BUDGET", "HTTP_BUDGET", "MODEL_REQUEST_BUDGET", "TASK_BUDGET"]);
    return { stage: providerCodes.has(row.code) ? "provider" : budgetCodes.has(row.code) ? "budget" : "execution", code: /^[A-Z_]{1,80}$/.test(row.code) ? row.code : "EXECUTION_FAILED" };
  }
  if (row?.name === "AI_APICallError" || typeof row?.statusCode === "number") return { stage: "provider", code: "PROVIDER_REQUEST_FAILED" };
  if (typeof row?.message === "string" && ["TIME_BUDGET", "STEP_BUDGET", "TOOL_CALL_BUDGET", "TOOL_CONTEXT_BUDGET"].includes(row.message)) return { stage: "budget", code: row.message };
  return { stage: "execution", code: "ANALYSIS_FAILED" };
}
