import { randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { budgetedProviderFetch, initializeProviderBudget, providerBudgetPolicySchema } from "@pitchroom/agent";
import { auditProviderBudget } from "./provider-budget-audit";
import { runTaskAcceptanceCLI } from "./cli";
const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit55-audit-"))); roots.push(root);
  const period = { checkedAt: "2026-01-01T00:00:00Z", validUntil: "2099-01-01T00:00:00Z" };
  const policy = providerBudgetPolicySchema.parse({ schemaVersion: 1, acceptanceId: randomUUID(), projectId: "synthetic-project", caseHash: "a".repeat(64), sourceHash: "b".repeat(64), provider: "synthetic", model: "synthetic-model", observedVersion: "synthetic-model", endpoint: "https://synthetic.invalid/responses",
    approval: { evidenceRef: "test-only", approvedAt: period.checkedAt, validUntil: period.validUntil }, pricing: { ...period, source: "https://synthetic.invalid/pricing", inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 }, inputCeiling: { ...period, source: "https://synthetic.invalid/context", tokens: 100 },
    limits: { requests: 2, inputTokens: 1000, outputTokens: 1000, microUsd: 3000, inputTokensPerRequest: 100, outputTokensPerRequest: 50, requestMs: 1000, modelActiveMs: 10_000, stageModelActiveMs: { understanding: 10_000, clarify: 10_000, positioning: 10_000, story: 10_000, legacy_deck: 10_000 }, requestBytes: 10_000, responseBytes: 10_000, ledgerBytes: 50_000 } });
  return { policy, handle: initializeProviderBudget(root, policy), operation: { acceptanceId: policy.acceptanceId, sessionId: randomUUID(), projectId: policy.projectId, caseHash: policy.caseHash, sourceHash: policy.sourceHash, stage: "clarify" as const, commandId: "test-command" } };
}
it("shows held unknown reservations and cumulative balances without writing or claiming acceptance", async () => {
  const f = fixture();
  await expect(budgetedProviderFetch({ ...f.handle, operation: f.operation, transport: async () => { throw new Error("test-only lost response"); } })(f.policy.endpoint, { method: "POST", body: JSON.stringify({ model: f.policy.model, max_output_tokens: 20 }) })).rejects.toThrow();
  const ledger = join(f.handle.directory, "provider.jsonl"), before = readFileSync(ledger, "utf8");
  const audit = auditProviderBudget(f.handle);
  expect(audit).toMatchObject({ kind: "provider_budget_integrity_only", state: "held_unknown", usedIncludingConservativeReservations: { requests: 1, inputTokens: 100, outputTokens: 20, microUsd: 140 }, remaining: { requests: 1, inputTokens: 900, outputTokens: 980 }, liveAdmission: "not_granted", modelQuality: "not_evaluated", sessions: [f.operation.sessionId] });
  expect(audit.stages.find(stage => stage.stage === "clarify")).toMatchObject({ requests: 1, activeMs: 1000 }); expect(readFileSync(ledger, "utf8")).toBe(before);
});
it("CLI audits only an explicit target and never calls the network", async () => {
  const f = fixture(), network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Unexpected network")), output: string[] = [];
  expect(await runTaskAcceptanceCLI(["provider-budget-audit", "--budget-directory", f.handle.directory, "--policy-hash", f.handle.policyHash], value => output.push(value))).toBe(0);
  expect(JSON.parse(output.join("")).result.usedIncludingConservativeReservations.requests).toBe(0); expect(network).not.toHaveBeenCalled();
  expect(await runTaskAcceptanceCLI(["provider-budget-audit"], () => undefined)).toBe(1);
  expect(await runTaskAcceptanceCLI(["provider-budget-audit", "--budget-directory", "relative", "--policy-hash", f.handle.policyHash], () => undefined)).toBe(1);
});
