import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { budgetedProviderFetch, initializeProviderBudget, inspectProviderBudget, type ProviderBudgetOperation, type ProviderBudgetPolicy } from "./provider-budget";
import { type ClarificationTask, type SourceRecord, type StorySnapshot, type ToolRepository, type UnderstandingProposalV1 } from "@pitchroom/domain";
import { createLiveUnderstandingRunner } from "./live-runner";
import { buildDeterministicPositioning, createLivePositioningRunner } from "./positioning-runner";
import { createLiveStoryRunner } from "./story-runner";
import { createModelClarificationRunner } from "./clarification-runner";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(overrides: Partial<ProviderBudgetPolicy["limits"]> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "pit55-budget-"))); roots.push(root);
  const now = Date.now();
  const policy: ProviderBudgetPolicy = {
    schemaVersion: 1, acceptanceId: randomUUID(), projectId: "synthetic-project", caseHash: "a".repeat(64), sourceHash: "b".repeat(64),
    provider: "synthetic", model: "synthetic-model", observedVersion: "synthetic-version", endpoint: "https://synthetic.invalid/v1/responses",
    approval: { evidenceRef: "synthetic-test-only", approvedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 60_000).toISOString() },
    pricing: { source: "https://synthetic.invalid/pricing", checkedAt: new Date(now - 1000).toISOString(), validUntil: new Date(now + 60_000).toISOString(), inputMicroUsdPerMillion: 1_000_000, outputMicroUsdPerMillion: 2_000_000 },
    limits: { requests: 4, inputTokens: 1000, outputTokens: 1000, microUsd: 3000, inputTokensPerRequest: 100, outputTokensPerRequest: 50, requestMs: 1000, modelActiveMs: 10_000, requestBytes: 10_000, responseBytes: 10_000, ledgerBytes: 50_000, ...overrides },
  };
  const handle = initializeProviderBudget(root, policy);
  const operation: ProviderBudgetOperation = { acceptanceId: policy.acceptanceId, sessionId: randomUUID(), projectId: policy.projectId, caseHash: policy.caseHash, sourceHash: policy.sourceHash, stage: "understanding", commandId: "synthetic-command" };
  return { root, policy, handle, operation };
}
const request = { method: "POST", body: JSON.stringify({ model: "synthetic-model", max_output_tokens: 20, input: "Private synthetic material must not enter the journal." }), headers: { authorization: "Bearer actual-key-synthetic-never-record" } };
const response = (usage: unknown = { input_tokens: 12, output_tokens: 7 }) => new Response(JSON.stringify({ model: "synthetic-model", status: "completed", usage, output: [] }), { status: 200 });

it("reserves before transport, settles actual usage, and records no bodies or credentials", async () => {
  const f = fixture();
  const transport = vi.fn<typeof fetch>(async (_url, init) => {
    const active = inspectProviderBudget(f.handle.directory, f.handle.policyHash);
    expect(active.state).toBe("pending"); expect(active.used.requests).toBe(1);
    expect(active.used.microUsd).toBe(140); expect(init?.redirect).toBe("error");
    expect(JSON.parse(String(init?.body)).store).toBe(false);
    expect(active.calls[0]?.reservation.requestHash).toBe(createHash("sha256").update(String(init?.body)).digest("hex"));
    return response();
  });
  const fetcher = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  expect((await fetcher(f.policy.endpoint, request)).status).toBe(200);
  const result = inspectProviderBudget(f.handle.directory, f.handle.policyHash);
  expect(result.state).toBe("ready"); expect(result.used).toMatchObject({ requests: 1, inputTokens: 12, outputTokens: 7, microUsd: 26 });
  const journal = readFileSync(join(f.handle.directory, "provider.jsonl"), "utf8");
  expect(journal).not.toContain("actual-key-synthetic-never-record"); expect(journal).not.toContain("Private synthetic material");
});

it("adds the frozen output cap when an SDK omits it and rejects an already-aborted request without reservation", async () => {
  const f = fixture(), transport = vi.fn<typeof fetch>(async (_url, init) => { expect(JSON.parse(String(init?.body)).max_output_tokens).toBe(50); return response(); });
  const call = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  const aborted = AbortSignal.abort();
  await expect(call(f.policy.endpoint, { ...request, signal: aborted })).rejects.toThrow("BUDGET_ABORTED");
  expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).used.requests).toBe(0);
  await call(f.policy.endpoint, { ...request, body: JSON.stringify({ model: "synthetic-model", input: "Synthetic SDK input" }) });
  expect(transport).toHaveBeenCalledTimes(1);
});

it("rejects expired pricing independently of the still-valid approval", async () => {
  const f = fixture();
  const policy = { ...f.policy, acceptanceId: randomUUID(), approval: { ...f.policy.approval, validUntil: new Date(Date.now() + 180_000).toISOString() } };
  const handle = initializeProviderBudget(f.root, policy), transport = vi.fn<typeof fetch>(async () => response());
  const operation = { ...f.operation, acceptanceId: policy.acceptanceId };
  const call = budgetedProviderFetch({ ...handle, operation, transport, now: () => Date.parse(policy.pricing.validUntil) + 1 });
  await expect(call(policy.endpoint, request)).rejects.toThrow("BUDGET_PRICING_EXPIRED"); expect(transport).not.toHaveBeenCalled();
});

it("stops before the next dispatch when its terminal-record allowance cannot fit", async () => {
  const f = fixture({ requests: 100, ledgerBytes: 5000 }), transport = vi.fn<typeof fetch>(async () => response());
  const call = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  let refused = false;
  for (let step = 0; step < 5; step++) {
    try { await call(f.policy.endpoint, request); }
    catch (error) { expect(error).toHaveProperty("code", "BUDGET_LEDGER_LIMIT"); refused = true; break; }
  }
  expect(refused).toBe(true); const state = inspectProviderBudget(f.handle.directory, f.handle.policyHash);
  expect(state.used.requests).toBe(transport.mock.calls.length); expect(state.bytes).toBeLessThanOrEqual(f.policy.limits.ledgerBytes);
});

it("counts tool-loop subrequests individually and changing session IDs cannot reset the acceptance budget", async () => {
  const f = fixture({ requests: 2 }), transport = vi.fn<typeof fetch>(async () => response());
  const first = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  await first(f.policy.endpoint, request); await first(f.policy.endpoint, request);
  const reopened = budgetedProviderFetch({ ...f.handle, operation: { ...f.operation, sessionId: randomUUID(), stage: "clarify" }, transport });
  await expect(reopened(f.policy.endpoint, request)).rejects.toThrow("BUDGET_REQUEST_LIMIT");
  expect(transport).toHaveBeenCalledTimes(2); expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).used.requests).toBe(2);
  expect(() => initializeProviderBudget(f.root, f.policy)).toThrow("BUDGET_ALREADY_EXISTS");
});

it("rejects missing approval, expired price, wrong binding, endpoint and request model before any dispatch", async () => {
  const f = fixture(), transport = vi.fn<typeof fetch>(async () => response());
  expect(() => initializeProviderBudget(f.root, { ...f.policy, approval: undefined })).toThrow();
  const later = Date.parse(f.policy.pricing.validUntil) + 1;
  const expired = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport, now: () => later });
  await expect(expired(f.policy.endpoint, request)).rejects.toThrow("BUDGET_APPROVAL_EXPIRED");
  const badBinding = budgetedProviderFetch({ ...f.handle, operation: { ...f.operation, projectId: "another-project" }, transport });
  await expect(badBinding(f.policy.endpoint, request)).rejects.toThrow("BUDGET_BINDING_MISMATCH");
  const good = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  await expect(good("https://other.invalid/responses", request)).rejects.toThrow("BUDGET_UNEXPECTED_REQUEST");
  await expect(good(f.policy.endpoint, { ...request, body: JSON.stringify({ model: "other", max_output_tokens: 20 }) })).rejects.toThrow("BUDGET_REQUEST_MODEL_OR_OUTPUT");
  expect(transport).not.toHaveBeenCalled(); expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).used.requests).toBe(0);
});

it("does not send when conservative cost, token, active-time or ledger reservations cannot fit", async () => {
  for (const limits of [{ microUsd: 1 }, { inputTokens: 99 }, { outputTokens: 19 }, { modelActiveMs: 999 }]) {
    const f = fixture(limits), transport = vi.fn<typeof fetch>(async () => response());
    const call = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
    await expect(call(f.policy.endpoint, request)).rejects.toThrow(/BUDGET_(LIMIT|LEDGER_LIMIT)/);
    expect(transport).not.toHaveBeenCalled();
  }
});

it("retains the full reservation after a lost response and refuses another operation after reopening", async () => {
  const f = fixture(), transport = vi.fn<typeof fetch>(async () => { throw new Error("Synthetic lost response"); });
  await expect(budgetedProviderFetch({ ...f.handle, operation: f.operation, transport })(f.policy.endpoint, request)).rejects.toThrow("Synthetic lost response");
  const state = inspectProviderBudget(f.handle.directory, f.handle.policyHash);
  expect(state.state).toBe("held_unknown"); expect(state.used).toMatchObject({ requests: 1, inputTokens: 100, outputTokens: 20, microUsd: 140, modelActiveMs: 1000 });
  const reopened = budgetedProviderFetch({ ...f.handle, operation: { ...f.operation, commandId: "explicit-new-command" }, transport });
  await expect(reopened(f.policy.endpoint, request)).rejects.toThrow("BUDGET_UNKNOWN_OUTCOME"); expect(transport).toHaveBeenCalledTimes(1);
});

it.each(["missing", "over-bound", "changed-model"] as const)("holds unknown usage for %s without refund or implicit retry", async mode => {
  const f = fixture();
  const transport = vi.fn<typeof fetch>(async () => mode === "missing" ? response(null) : mode === "over-bound" ? response({ input_tokens: 101, output_tokens: 1 }) : new Response(JSON.stringify({ model: "unapproved-model", usage: { input_tokens: 1, output_tokens: 1 } })));
  await expect(budgetedProviderFetch({ ...f.handle, operation: f.operation, transport })(f.policy.endpoint, request)).rejects.toThrow();
  expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).state).toBe("held_unknown");
  expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).used.microUsd).toBe(140); expect(transport).toHaveBeenCalledTimes(1);
});

it("bounds a transport that ignores abort and keeps the pending cost after timeout", async () => {
  const f = fixture({ requestMs: 10 });
  const transport = vi.fn<typeof fetch>(() => new Promise<Response>(() => undefined));
  await expect(budgetedProviderFetch({ ...f.handle, operation: f.operation, transport })(f.policy.endpoint, request)).rejects.toThrow("BUDGET_DEADLINE");
  expect(inspectProviderBudget(f.handle.directory, f.handle.policyHash).state).toBe("held_unknown"); expect(transport).toHaveBeenCalledTimes(1);
});

it("blocks simultaneous transports while one reservation is pending", async () => {
  const f = fixture({ requests: 1 }); let finish: ((response: Response) => void) | undefined;
  const transport = vi.fn<typeof fetch>(() => new Promise<Response>(resolve => { finish = resolve; }));
  const call = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  const first = call(f.policy.endpoint, request);
  await expect(call(f.policy.endpoint, request)).rejects.toThrow("BUDGET_BUSY");
  if (!finish) throw new Error("Synthetic transport did not start"); finish(response()); await first;
  expect(transport).toHaveBeenCalledTimes(1);
});

it("honors a lock held by a separate process and makes no provider request", async () => {
  const f = fixture(), lock = join(f.handle.directory, ".provider-lock");
  const child = spawn(process.execPath, ["-e", 'const fs=require("node:fs");fs.mkdirSync(process.argv[1],{mode:0o700});process.stdout.write("locked\\n");process.stdin.once("data",()=>{fs.rmdirSync(process.argv[1]);process.exit(0)});', lock], { stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise<number | null>(resolve => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", () => reject(new Error("Synthetic lock process exited early"))); });
    const transport = vi.fn<typeof fetch>(async () => response());
    await expect(budgetedProviderFetch({ ...f.handle, operation: f.operation, transport })(f.policy.endpoint, request)).rejects.toThrow("BUDGET_BUSY"); expect(transport).not.toHaveBeenCalled();
  } finally { child.stdin.write("release\n"); expect(await closed).toBe(0); }
});

it("refuses partial journals, altered policies and symlinked state without dispatch", async () => {
  const f = fixture(), transport = vi.fn<typeof fetch>(async () => response());
  const call = budgetedProviderFetch({ ...f.handle, operation: f.operation, transport });
  await expect(budgetedProviderFetch({ ...f.handle, policyHash: "c".repeat(64), operation: f.operation, transport })(f.policy.endpoint, request)).rejects.toThrow("BUDGET_POLICY_CHANGED");
  appendFileSync(join(f.handle.directory, "provider.jsonl"), "{");
  await expect(call(f.policy.endpoint, request)).rejects.toThrow("BUDGET_PARTIAL_WRITE");
  const linked = join(f.root, "linked"); symlinkSync(f.handle.directory, linked);
  await expect(budgetedProviderFetch({ directory: linked, policyHash: f.handle.policyHash, operation: f.operation, transport })(f.policy.endpoint, request)).rejects.toThrow("BUDGET_SYMLINK");
  expect(transport).not.toHaveBeenCalled();
});

const chunk = { id: "synthetic-chunk", sourceId: "synthetic-source", text: "The pilot has twelve teams.", startOffset: 0, endOffset: 27 };
const source: SourceRecord = { id: chunk.sourceId, projectId: "synthetic-project", name: "synthetic.txt", mediaType: "text/plain", contentHash: "d".repeat(64), chunks: [chunk] };
const understanding: UnderstandingProposalV1 = {
  schemaVersion: 1, themes: [{ id: "u:theme:0", title: "Pilot", summary: "The pilot has twelve teams.", claims: [{ id: "u:claim:0", statement: chunk.text, evidenceState: "supported", evidence: [{ sourceId: source.id, chunkId: chunk.id, quote: chunk.text }], userInputIds: [] }] }],
  gaps: [{ description: "Budget is unknown.", whyItMatters: "Approval", relatedSourceIds: [source.id] }],
  nextQuestion: { question: "What decision is needed?", whyItMatters: "Discussion", relatedThemeIndexes: [0] },
};
const repository: ToolRepository = {
  async listSources() { return [source]; }, async getSource() { return source; }, async getChunk() { return chunk; },
};
const positioningInput = { understandingVersionId: "u", understanding, chunks: [chunk] };
const positioning = buildDeterministicPositioning(positioningInput);
const storySnapshot: StorySnapshot = {
  origin: { understandingVersionId: "u", positioningVersionId: "p", sourceFingerprint: "synthetic-sources", directionId: "evidence-first" },
  understanding, positioning, sources: [source], before: null, request: { kind: "develop_direction" }, userInput: null, model: "synthetic-model", promptVersion: "synthetic-control",
};
const clarification: ClarificationTask = {
  id: "synthetic-task", createdAt: new Date().toISOString(), runMode: "live", projectId: source.projectId, inputId: "synthetic-answer", commandId: "synthetic-clarify", actorId: "synthetic-operator",
  baseUnderstandingId: "u", baseRevision: 1, sourceFingerprint: "synthetic-sources", answer: "The budget is not agreed.", question: understanding.nextQuestion,
  base: understanding, sources: [source], status: "running", attempts: [],
};
const factories: { name: string; stage: ProviderBudgetOperation["stage"]; baseURL: string; run: (transport: typeof fetch) => Promise<unknown> }[] = [
  { name: "SDK Understanding", stage: "understanding", baseURL: "https://synthetic.invalid/v1", run: transport => createLiveUnderstandingRunner(repository, { apiKey: "test-synthetic-only", model: "synthetic-model", baseURL: "https://synthetic.invalid/v1", fetch: transport }).run({ projectId: source.projectId, chunks: [chunk] }) },
  { name: "DeepSeek Understanding", stage: "understanding", baseURL: "https://api.deepseek.com", run: transport => createLiveUnderstandingRunner(repository, { apiKey: "test-synthetic-only", model: "synthetic-model", baseURL: "https://api.deepseek.com", fetch: transport }).run({ projectId: source.projectId, chunks: [chunk] }) },
  { name: "Positioning", stage: "positioning", baseURL: "https://synthetic.invalid/v1", run: transport => createLivePositioningRunner({ apiKey: "test-synthetic-only", model: "synthetic-model", baseURL: "https://synthetic.invalid/v1", fetch: transport }).run(positioningInput) },
  { name: "Story", stage: "story", baseURL: "https://synthetic.invalid/v1", run: transport => createLiveStoryRunner({ apiKey: "test-synthetic-only", model: "synthetic-model", baseURL: "https://synthetic.invalid/v1", fetch: transport }).run(storySnapshot) },
  { name: "Clarify", stage: "clarify", baseURL: "https://synthetic.invalid/v1", run: transport => createModelClarificationRunner({ apiKey: "test-synthetic-only", model: "synthetic-model", baseURL: "https://synthetic.invalid/v1", fetch: transport }).run(clarification) },
];
it.each(factories)("routes $name through the shared reservation and performs no automatic retry", async factory => {
  const f = fixture({ outputTokensPerRequest: 20_000, outputTokens: 100_000, microUsd: 100_000, requestBytes: 200_000 });
  const policy = { ...f.policy, acceptanceId: randomUUID(), endpoint: factory.baseURL + "/responses" };
  const handle = initializeProviderBudget(f.root, policy);
  const transport = vi.fn<typeof fetch>(async () => {
    expect(inspectProviderBudget(handle.directory, handle.policyHash).state).toBe("pending");
    return new Response(JSON.stringify({ model: policy.model, status: "failed", usage: { input_tokens: 12, output_tokens: 7 }, error: { message: "Synthetic provider failure" } }), { status: 500 });
  });
  const controlled = budgetedProviderFetch({ ...handle, operation: { ...f.operation, acceptanceId: policy.acceptanceId, stage: factory.stage }, transport });
  await expect(factory.run(controlled)).rejects.toThrow();
  expect(transport).toHaveBeenCalledTimes(1);
  expect(inspectProviderBudget(handle.directory, handle.policyHash).used.requests).toBe(1);
});
