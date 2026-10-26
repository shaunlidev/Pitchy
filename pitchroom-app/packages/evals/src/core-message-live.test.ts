import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { prepareCoreMessageLiveSession, reprocessCoreMessageCandidate, runCoreMessageLiveSession, verifyCoreMessageReview } from "./core-message-live";

const config = {
  baseUrl: "https://api.openai.com/v1",
  model: "gpt-test-2026-10-25",
  maxOutputTokens: 2_000,
  maxInputTokens: 10_000,
  maxCostMicroUsd: 100_000,
  inputMicroUsdPerMillionTokens: 1_000_000,
  outputMicroUsdPerMillionTokens: 1_000_000,
  pricingSource: "https://example.com/pricing",
  pricingCheckedAt: "2026-10-25",
};
const deepSeekConfig = {
  provider: "deepseek" as const, model: "deepseek-flash" as const,
  observedVersion: "DeepSeek-V4.1-Flash-1017" as const, baseURL: "https://api.deepseek.com" as const,
  reasoningEffort: "high" as const, inputAccounting: "context-window-reservation" as const,
  contextWindowTokens: 1_048_576 as const, inputUsdPerMillion: 0.30, outputUsdPerMillion: 1.20,
  countRequestMicroUsd: 0 as const, pricingSource: "https://api-docs.deepseek.com/quick_start/pricing/", pricingCheckedAt: "2026-10-24T23:56:19Z",
};

const ev = (sourceId: string, quote: string) => ({ sourceId, quote, interpretation: "Grounds this hypothesis." });
const proposal = {
  schemaVersion: 2,
  originalFraming: { label: "Original framing", coreMessage: "An all-in-one API development platform." },
  hypotheses: [
    {
      id: "sync", lens: "mechanism", title: "Change propagation", audience: "API product teams", audienceSituation: "They repeat changes across tools.", positioningThesis: "Use one API specification to keep dependent workflow assets aligned.", coreMessage: "Change it once. Keep every API handoff aligned.", audienceRecognition: "API teams recognize repeated reconciliation work.",
      from: "Manual copying across tools.", to: "One definition keeps assets aligned.", hiddenTradeoff: "Speed versus alignment.",
      mechanism: "A shared API specification drives dependent assets.", humanPayoff: "Less manual synchronization.",
      emphasis: ["Propagation"], exclusions: ["Automatic code mutation"],
      supportingEvidence: [ev("official-homepage", "linked to the same OpenAPI definition")],
      counterEvidence: [ev("g2-review-patterns", "learning curve, interface density, resource use, and migration friction")], unknowns: ["Primary migration trigger"],
    },
    {
      id: "parallel", lens: "human_tension", title: "Parallel work", audience: "Frontend, backend, and QA teams", audienceSituation: "They reconcile different API representations.", positioningThesis: "Use one API contract across mocks, tests, and documentation instead of copying changes.", coreMessage: "One API contract. Fewer cross-team handoff gaps.", audienceRecognition: "Cross-functional teams recognize handoff inconsistency.",
      from: "Sequential handoffs.", to: "Parallel work.", hiddenTradeoff: "Speed versus coordination.", mechanism: "A shared specification.", humanPayoff: "Less waiting.",
      emphasis: ["Coordination"], exclusions: ["Zero defects"],
      supportingEvidence: [ev("official-collaboration-workflow", "connects specification, frontend mocks, backend debugging, saved endpoint cases, QA testing, integration testing, and shared documentation")],
      counterEvidence: [], unknowns: ["Buying trigger"],
    },
  ],
  leadingHypothesisId: "sync",
  recommendation: {
    hypothesisId: "sync",
    judgment: "Lead with change propagation because the mechanism is more distinctive.",
    comparison: "Change propagation is more specific; parallel work is more emotionally legible but more common.",
    conditionsToReconsider: ["Prefer parallel work if customer evidence identifies waiting as the buying trigger."],
  },
  clarifyingQuestion: null,
};

function freshSession() {
  const parent = mkdtempSync(join(tmpdir(), "pitchroom-core-message-"));
  return join(parent, "session");
}

describe("controlled core-message live runner", () => {
  it("prepares locally without a transport or network request", () => {
    const root = freshSession();
    const manifest = prepareCoreMessageLiveSession(root, config);
    expect(manifest).toMatchObject({ state: "prepared", networkRequests: 0 });
  });

  it("uses exactly token-count and generation endpoints, then waits for human review", async () => {
    const root = freshSession(); prepareCoreMessageLiveSession(root, config);
    const urls: string[] = [];
    const transport = async (url: string) => {
      urls.push(url);
      return new Response(JSON.stringify(url.endsWith("/input_tokens") ? { input_tokens: 1 } : { output_text: JSON.stringify(proposal), usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } });
    };
    const result = await runCoreMessageLiveSession(root, "secret", transport);
    expect(urls).toEqual(["https://api.openai.com/v1/responses/input_tokens", "https://api.openai.com/v1/responses"]);
    expect(result).toMatchObject({ status: "awaiting_human_review", networkRequests: 2 });
    expect(readFileSync(join(root, "output.json"), "utf8")).not.toContain("secret");
    await expect(runCoreMessageLiveSession(root, "secret", transport)).rejects.toThrow("SESSION_NOT_RUNNABLE");
  });

  it("binds a completed human review to the exact output hash", async () => {
    const root = freshSession(); prepareCoreMessageLiveSession(root, config);
    await runCoreMessageLiveSession(root, "secret", async (url) => new Response(JSON.stringify(url.endsWith("/input_tokens") ? { input_tokens: 1 } : { output_text: JSON.stringify(proposal), usage: { input_tokens: 1, output_tokens: 1 } }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const path = join(root, "review.json");
    const review = JSON.parse(readFileSync(path, "utf8"));
    Object.assign(review, { reviewer: "human", verdict: "pass", dimensions: { groundedness: 3, mechanismClarity: 4, differentiation: 3, decisionUsefulness: 4 }, preservedCoreJudgment: "Spec change propagates through the workflow.", notes: "Compared both hypotheses." });
    writeFileSync(path, `${JSON.stringify(review, null, 2)}\n`);
    expect(verifyCoreMessageReview(root)).toMatchObject({ accepted: true, mean: 3.5 });
    review.outputHash = "tampered"; writeFileSync(path, JSON.stringify(review));
    expect(() => verifyCoreMessageReview(root)).toThrow("REVIEW_OUTPUT_HASH_MISMATCH");
  });

  it("reuses the reviewed DeepSeek contract with one generation request and context reservation", async () => {
    const root = freshSession(); prepareCoreMessageLiveSession(root, deepSeekConfig);
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const result = await runCoreMessageLiveSession(root, "secret", async (url, init) => {
      calls.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ model: "deepseek-flash", status: "completed", usage: { input_tokens: 500, output_tokens: 100 }, output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }] }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: "https://api.deepseek.com/responses", body: { model: "deepseek-flash", reasoning: { effort: "high" }, max_output_tokens: 8000, store: false } });
    expect(((calls[0]!.body.text as { format: Record<string, unknown> }).format)).not.toHaveProperty("strict");
    expect(result).toMatchObject({ status: "awaiting_human_review", networkRequests: 1 });
    expect(JSON.parse(readFileSync(join(root, "output.json"), "utf8"))).toMatchObject({ provider: "deepseek", observedVersion: "DeepSeek-V4.1-Flash-1017", accounting: { method: "context-window-reservation", reservedCostMicroUsd: 324173, actualCostMicroUsd: 270 } });
  });

  it("records safe incomplete diagnostics without recording reasoning content", async () => {
    const root = freshSession(); prepareCoreMessageLiveSession(root, { ...deepSeekConfig, reasoningEffort: "low" });
    await expect(runCoreMessageLiveSession(root, "secret", async () => new Response(JSON.stringify({
      model: "deepseek-flash", status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
      usage: { input_tokens: 500, output_tokens: 8000, output_tokens_details: { reasoning_tokens: 7990 } },
      output: [{ type: "reasoning", status: "incomplete", content: [{ type: "reasoning_text", text: "must remain private" }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }))).rejects.toThrow("PROVIDER_NOT_COMPLETED");
    const failure = readFileSync(join(root, "failure.json"), "utf8");
    expect(failure).toContain("max_output_tokens");
    expect(failure).toContain("reasoning_tokens");
    expect(failure).not.toContain("must remain private");
  });

  it("preserves visible candidate output and validation diagnostics", async () => {
    const root = freshSession(); prepareCoreMessageLiveSession(root, { ...deepSeekConfig, reasoningEffort: "low" });
    const invalidResponse = {
      model: "deepseek-flash", status: "completed", usage: { input_tokens: 500, output_tokens: 100 },
      output: [{ type: "message", content: [{ type: "output_text", text: "{\"schemaVersion\":1}" }] }],
    };
    const transport = async () => new Response(JSON.stringify(invalidResponse), { status: 200, headers: { "Content-Type": "application/json" } });
    await expect(runCoreMessageLiveSession(root, "secret", transport)).rejects.toThrow("OUTPUT_VALIDATION_FAILED");
    expect(readFileSync(join(root, "candidate.json"), "utf8")).toContain("schemaVersion");
    expect(readFileSync(join(root, "failure.json"), "utf8")).toContain("OUTPUT_VALIDATION_FAILED");
  });

  it("reprocesses a saved candidate into a new zero-network review session", async () => {
    const source = freshSession(); prepareCoreMessageLiveSession(source, { ...deepSeekConfig, reasoningEffort: "low" });
    await runCoreMessageLiveSession(source, "secret", async () => new Response(JSON.stringify({
      model: "deepseek-flash", status: "completed", usage: { input_tokens: 500, output_tokens: 100 },
      output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(proposal) }] }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    const manifestPath = join(source, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")); manifest.state = "failed";
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const target = freshSession();
    expect(reprocessCoreMessageCandidate(source, target)).toMatchObject({ status: "awaiting_human_review", networkRequests: 0 });
    expect(readFileSync(join(target, "review.json"), "utf8")).toContain('"verdict": "pending"');
  });
});
