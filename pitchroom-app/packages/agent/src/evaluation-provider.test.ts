import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { evaluationProviderFetch } from "./evaluation-provider";
import { initializeProviderBudget, inspectProviderBudget, type ProviderBudgetPolicy } from "./provider-budget";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit55-reference-"))); roots.push(root);
  const policy: ProviderBudgetPolicy = {
    schemaVersion: 1, acceptanceId: randomUUID(), projectId: "isolated-project", caseHash: "a".repeat(64), sourceHash: "b".repeat(64),
    provider: "synthetic", model: "synthetic-model", observedVersion: "synthetic-version", endpoint: "https://synthetic.invalid/v1/responses",
    approval: { evidenceRef: "test-synthetic-only", approvedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
    pricing: { source: "https://synthetic.invalid/pricing", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z", inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 },
    limits: { requests: 2, inputTokens: 1000, outputTokens: 1000, microUsd: 3000, inputTokensPerRequest: 100, outputTokensPerRequest: 50, requestMs: 1000, modelActiveMs: 10_000, requestBytes: 10_000, responseBytes: 10_000, ledgerBytes: 50_000 },
  };
  const handle = initializeProviderBudget(root, policy);
  const reference = { schemaVersion: 1, ...handle, sessionId: randomUUID(), instanceId: randomUUID(), sourceHash: policy.sourceHash, caseHash: policy.caseHash };
  const path = join(root, "reference.json"); writeFileSync(path, JSON.stringify(reference), { mode: 0o600 });
  const environment: Record<string, string | undefined> = { PITCHROOM_EVAL_BUDGET_FILE: path, PITCHROOM_EVAL_INSTANCE_ID: reference.instanceId, PITCHROOM_EVAL_SOURCE_HASH: policy.sourceHash, PITCHROOM_EVAL_CASE_HASH: policy.caseHash, PITCHROOM_LIVE_TRANSFER_ACK: "authorized", OPENAI_API_KEY: "test-synthetic-only", OPENAI_MODEL: policy.model, OPENAI_BASE_URL: "https://synthetic.invalid/v1" };
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: policy.model, usage: { input_tokens: 12, output_tokens: 7 } })));
  return { root, path, policy, handle, reference, environment, transport, input: { environment, projectId: policy.projectId, stage: "story" as const, commandId: "synthetic-command", transport } };
}
const request = { method: "POST", body: JSON.stringify({ model: "synthetic-model", max_output_tokens: 20 }) };
it("preserves ordinary configuration and refuses every partial evaluation configuration", () => {
  const f = fixture(); expect(evaluationProviderFetch({ ...f.input, environment: {} })).toBeUndefined();
  for (const key of ["PITCHROOM_EVAL_BUDGET_FILE", "PITCHROOM_EVAL_INSTANCE_ID", "PITCHROOM_EVAL_SOURCE_HASH", "PITCHROOM_EVAL_CASE_HASH"]) expect(() => evaluationProviderFetch({ ...f.input, environment: { [key]: f.environment[key] } })).toThrow("BUDGET_EVALUATION_CONFIG");
  expect(f.transport).not.toHaveBeenCalled();
});
it("continues cumulative consumption after replacing the session reference", async () => {
  const f = fixture(), first = evaluationProviderFetch(f.input); if (!first) throw new Error("Expected budgeted transport"); await first(f.policy.endpoint, request);
  writeFileSync(f.path, JSON.stringify({ ...f.reference, sessionId: randomUUID() }));
  const next = evaluationProviderFetch(f.input); if (!next) throw new Error("Expected budgeted transport"); await next(f.policy.endpoint, request);
  await expect(next(f.policy.endpoint, request)).rejects.toThrow("BUDGET_REQUEST_LIMIT");
  const state = inspectProviderBudget(f.handle.directory, f.handle.policyHash); expect(state.used.requests).toBe(2); expect(new Set(state.calls.map(call => call.reservation.sessionId)).size).toBe(2); expect(f.transport).toHaveBeenCalledTimes(2);
});
it("refuses changed identity, project, model, endpoint and permission before dispatch", () => {
  const f = fixture();
  for (const [key, value] of Object.entries({ PITCHROOM_EVAL_INSTANCE_ID: randomUUID(), PITCHROOM_EVAL_SOURCE_HASH: "c".repeat(64), PITCHROOM_EVAL_CASE_HASH: "d".repeat(64), OPENAI_MODEL: "other", OPENAI_BASE_URL: "https://other.invalid/v1", PITCHROOM_LIVE_TRANSFER_ACK: "denied", OPENAI_API_KEY: "" })) expect(() => evaluationProviderFetch({ ...f.input, environment: { ...f.environment, [key]: value } })).toThrow();
  expect(() => evaluationProviderFetch({ ...f.input, projectId: "other-project" })).toThrow("BUDGET_BINDING_MISMATCH"); expect(f.transport).not.toHaveBeenCalled(); expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).used.requests).toBe(0);
});
it("refuses missing, public, oversized, symlinked and tampered references", () => {
  const f = fixture(); expect(() => evaluationProviderFetch({ ...f.input, environment: { ...f.environment, PITCHROOM_EVAL_BUDGET_FILE: join(f.root, "missing") } })).toThrow();
  chmodSync(f.path, 0o644); expect(() => evaluationProviderFetch(f.input)).toThrow("BUDGET_REFERENCE_PATH"); chmodSync(f.path, 0o600);
  const link = join(f.root, "link"); symlinkSync(f.path, link); expect(() => evaluationProviderFetch({ ...f.input, environment: { ...f.environment, PITCHROOM_EVAL_BUDGET_FILE: link } })).toThrow("BUDGET_SYMLINK");
  writeFileSync(f.path, " ".repeat(4097)); expect(() => evaluationProviderFetch(f.input)).toThrow("BUDGET_REFERENCE_PATH");
  writeFileSync(f.path, JSON.stringify({ ...f.reference, policyHash: "c".repeat(64) })); expect(() => evaluationProviderFetch(f.input)).toThrow(); expect(f.transport).not.toHaveBeenCalled();
});
