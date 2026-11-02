import { randomUUID } from "node:crypto";
import { chmodSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { evaluationProviderFetch, evaluationProviderIdentity, evaluationProviderProjectId, evaluationProviderReferenceHash, evaluationProviderTargetFingerprint } from "./evaluation-provider";
import { initializeProviderBudget, inspectProviderBudget, type ProviderBudgetPolicy } from "./provider-budget";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit55-reference-"))); roots.push(root);
  const policy: ProviderBudgetPolicy = {
    schemaVersion: 1, acceptanceId: randomUUID(), projectId: randomUUID(), caseHash: "a".repeat(64), sourceHash: "b".repeat(64),
    provider: "synthetic", model: "synthetic-model", observedVersion: "synthetic-model", endpoint: "https://synthetic.invalid/v1/responses",
    approval: { evidenceRef: "test-synthetic-only", approvedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
    pricing: { source: "https://synthetic.invalid/pricing", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z", inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 },
    inputCeiling: { tokens: 100, source: "https://synthetic.invalid/context", checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" },
    limits: { requests: 2, inputTokens: 1000, outputTokens: 1000, microUsd: 3000, inputTokensPerRequest: 100, outputTokensPerRequest: 50, requestMs: 1000, modelActiveMs: 10_000, stageModelActiveMs: { understanding: 10_000, clarify: 10_000, positioning: 10_000, story: 10_000, legacy_deck: 10_000 }, requestBytes: 10_000, responseBytes: 10_000, ledgerBytes: 50_000 },
  };
  const handle = initializeProviderBudget(root, policy);
  const DATABASE_URL = "postgres://test-user:synthetic@127.0.0.1:55455/pit55_" + "a".repeat(32);
  const reference = { schemaVersion: 1, ...handle, sessionId: randomUUID(), instanceId: randomUUID(), sourceHash: policy.sourceHash, caseHash: policy.caseHash, targetFingerprint: evaluationProviderTargetFingerprint(DATABASE_URL) };
  const path = join(root, "reference.json"); writeFileSync(path, JSON.stringify(reference), { mode: 0o600 });
  const environment: Record<string, string | undefined> = { PITCHROOM_EVAL_BUDGET_FILE: path, PITCHROOM_EVAL_INSTANCE_ID: reference.instanceId, PITCHROOM_EVAL_SOURCE_HASH: policy.sourceHash, PITCHROOM_EVAL_CASE_HASH: policy.caseHash, PITCHROOM_LIVE_TRANSFER_ACK: "authorized", OPENAI_API_KEY: "test-synthetic-only", OPENAI_MODEL: policy.model, OPENAI_BASE_URL: "https://synthetic.invalid/v1" };
  environment.DATABASE_URL = DATABASE_URL; environment.PITCHROOM_EVAL_REFERENCE_HASH = evaluationProviderReferenceHash(reference);
  const transport = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ model: policy.model, usage: { input_tokens: 12, output_tokens: 7 } })));
  return { root, path, policy, handle, reference, environment, transport, input: { environment, projectId: policy.projectId, stage: "story" as const, commandId: "synthetic-command", transport } };
}
const request = { method: "POST", body: JSON.stringify({ model: "synthetic-model", max_output_tokens: 20 }) };
it("preserves ordinary configuration and refuses every partial evaluation configuration", () => {
  const f = fixture(); expect(evaluationProviderFetch({ ...f.input, environment: {} })).toBeUndefined();
  for (const key of ["PITCHROOM_EVAL_BUDGET_FILE", "PITCHROOM_EVAL_INSTANCE_ID", "PITCHROOM_EVAL_SOURCE_HASH", "PITCHROOM_EVAL_CASE_HASH"]) expect(() => evaluationProviderFetch({ ...f.input, environment: { [key]: f.environment[key] } })).toThrow("BUDGET_EVALUATION_CONFIG");
  expect(f.transport).not.toHaveBeenCalled();
});
it("requires a new launch binding when replacing a session and retains cumulative consumption", async () => {
  const f = fixture(), first = evaluationProviderFetch(f.input); if (!first) throw new Error("Expected budgeted transport"); await first(f.policy.endpoint, request);
  const replacement = { ...f.reference, sessionId: randomUUID() }; writeFileSync(f.path, JSON.stringify(replacement));
  expect(() => evaluationProviderFetch(f.input)).toThrow("BUDGET_REFERENCE_CHANGED");
  f.environment.PITCHROOM_EVAL_REFERENCE_HASH = evaluationProviderReferenceHash(replacement);
  const next = evaluationProviderFetch(f.input); if (!next) throw new Error("Expected budgeted transport"); await next(f.policy.endpoint, request);
  await expect(next(f.policy.endpoint, request)).rejects.toThrow("BUDGET_REQUEST_LIMIT");
  const state = inspectProviderBudget(f.handle.directory, f.handle.policyHash); expect(state.used.requests).toBe(2); expect(new Set(state.calls.map(call => call.reservation.sessionId)).size).toBe(2); expect(f.transport).toHaveBeenCalledTimes(2);
});

it("binds both runtimes to an exact isolated database and exposes no connection credentials", () => {
  const f = fixture(), identity = evaluationProviderIdentity(f.environment, 123);
  expect(identity).toMatchObject({ kind: "isolated_budget_evaluation", pid: 123, acceptanceId: f.policy.acceptanceId, sessionId: f.reference.sessionId, referenceHash: f.environment.PITCHROOM_EVAL_REFERENCE_HASH });
  expect(JSON.stringify(identity)).not.toContain("test-user"); expect(JSON.stringify(identity)).not.toContain(f.handle.directory);
  for (const DATABASE_URL of [undefined, "postgres://test-user:synthetic@localhost:55455/pit55_" + "a".repeat(32), "postgres://test-user:synthetic@127.0.0.1:55455/daily", f.environment.DATABASE_URL + "?host=remote", f.environment.DATABASE_URL?.replace("55455", "55456")]) {
    expect(() => evaluationProviderProjectId({ ...f.environment, DATABASE_URL })).toThrow();
  }
  expect(f.transport).not.toHaveBeenCalled();
});

it("refuses worker claims with unresolved provider usage and records the exact retry attempt", async () => {
  const f = fixture();
  expect(() => evaluationProviderFetch({ ...f.input, stage: "clarify" })).toThrow("BUDGET_WORKER_ATTEMPT");
  const workerAttempt = { taskId: randomUUID(), attemptId: "task:attempt:2" };
  const run = evaluationProviderFetch({ ...f.input, stage: "clarify", commandId: "explicit-retry-2", workerAttempt, transport: async () => new Response("{}") });
  if (!run) throw new Error("Expected budgeted transport");
  await expect(run(f.policy.endpoint, request)).rejects.toThrow();
  expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).calls[0]?.reservation).toMatchObject({ commandId: "explicit-retry-2", workerAttempt });
  expect(() => evaluationProviderProjectId(f.environment)).toThrow("BUDGET_UNRESOLVED_CALL");
});

it("distinguishes an in-flight shared reservation from an unknown outcome", async () => {
  const f = fixture(); let entered!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const run = evaluationProviderFetch({ ...f.input, transport: async () => { entered(); await gate; return new Response(JSON.stringify({ model: f.policy.model, usage: { input_tokens: 12, output_tokens: 7 } })); } });
  if (!run) throw new Error("Expected budgeted transport");
  const completed = run(f.policy.endpoint, request); await started;
  expect(() => evaluationProviderProjectId(f.environment)).toThrow("BUDGET_BUSY");
  release(); await completed;
  expect(evaluationProviderProjectId(f.environment)).toBe(f.policy.projectId);
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

it("derives the worker project only from a fully bound reference before claiming work", () => {
  const f = fixture(); expect(evaluationProviderProjectId({})).toBeUndefined();
  expect(evaluationProviderProjectId(f.environment)).toBe(f.policy.projectId);
  expect(() => evaluationProviderProjectId({ ...f.environment, PITCHROOM_EVAL_SOURCE_HASH: "f".repeat(64) })).toThrow("BUDGET_REFERENCE_MISMATCH");
  expect(() => evaluationProviderProjectId({ PITCHROOM_EVAL_INSTANCE_ID: f.reference.instanceId })).toThrow("BUDGET_EVALUATION_CONFIG");
  expect(f.transport).not.toHaveBeenCalled();
});
