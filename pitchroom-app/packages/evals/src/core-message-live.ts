import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { apidogSources } from "./core-message-apidog-cases";
import { precheckCoreMessage } from "./core-message-eval";
import { deepSeekOutputSchema } from "./clarification-deepseek-schema";
import type { CoreMessageSource } from "./core-message-types";
import {
  buildCoreMessagePromptInput,
  coreMessageJsonSchema,
  coreMessagePromptVersion,
  coreMessageSystemPrompt,
  parseCoreMessageProposalText,
} from "./core-message-prompt";

export class CoreMessageLiveStop extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

const openAiCoreMessageConfigSchema = z.object({
  provider: z.literal("openai").optional(),
  baseUrl: z.string().url().refine((value) => value.startsWith("https://") && value.endsWith("/v1")),
  model: z.string().regex(/-\d{4}-\d{2}-\d{2}$/),
  maxOutputTokens: z.number().int().min(500).max(4_000),
  maxInputTokens: z.number().int().min(1).max(20_000),
  maxCostMicroUsd: z.number().int().min(1).max(1_000_000),
  inputMicroUsdPerMillionTokens: z.number().int().nonnegative(),
  outputMicroUsdPerMillionTokens: z.number().int().nonnegative(),
  pricingSource: z.string().url(),
  pricingCheckedAt: z.string().date(),
});
const deepSeekCoreMessageConfigSchema = z.object({
  provider: z.literal("deepseek"),
  model: z.literal("deepseek-flash"),
  observedVersion: z.literal("DeepSeek-V4.1-Flash-1017"),
  baseURL: z.literal("https://api.deepseek.com"),
  reasoningEffort: z.enum(["low", "high"]),
  maxOutputTokens: z.number().int().min(8_000).max(20_000).optional(),
  inputAccounting: z.literal("context-window-reservation"),
  contextWindowTokens: z.literal(1_048_576),
  inputUsdPerMillion: z.number().finite().min(0.3),
  outputUsdPerMillion: z.number().finite().min(1.2),
  countRequestMicroUsd: z.literal(0),
  pricingSource: z.string().url(),
  pricingCheckedAt: z.string().datetime(),
});
export const coreMessageLiveConfigSchema = z.union([openAiCoreMessageConfigSchema, deepSeekCoreMessageConfigSchema]);
export type CoreMessageLiveConfig = z.infer<typeof coreMessageLiveConfigSchema>;
export const coreMessageFixtureSchema = z.object({
  id: z.string().min(1),
  evaluationProfile: z.enum(["apidog_change_propagation", "generic_core_message"]),
  originalFraming: z.string().min(1),
  sources: z.array(z.object({ id: z.string().min(1), authority: z.string().min(1), url: z.string().url(), material: z.string().min(1), boundary: z.string().min(1) })).min(1),
});
export type CoreMessageFixture = z.infer<typeof coreMessageFixtureSchema>;

type Transport = (url: string, init: RequestInit) => Promise<Response>;
type Manifest = { version: 1; state: "prepared" | "dispatched" | "awaiting_human_review" | "failed"; config: CoreMessageLiveConfig; promptVersion: string; inputHash: string; fixtureId: string; evaluationProfile: CoreMessageFixture["evaluationProfile"]; networkRequests: number; derivedFromCandidateHash?: string };

const defaultFixture: CoreMessageFixture = { id: "apidog-v1", evaluationProfile: "apidog_change_propagation", originalFraming: "An all-in-one API development platform.", sources: apidogSources };
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const readJson = <T>(path: string) => JSON.parse(readFileSync(path, "utf8")) as T;
const writeExclusive = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
const writeReplace = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });

export function prepareCoreMessageLiveSession(root: string, rawConfig: unknown, rawFixture: unknown = defaultFixture) {
  const config = coreMessageLiveConfigSchema.parse(rawConfig);
  const fixture = coreMessageFixtureSchema.parse(rawFixture);
  mkdirSync(root, { recursive: false, mode: 0o700 });
  const input = buildCoreMessagePromptInput({ originalFraming: fixture.originalFraming, sources: fixture.sources });
  const inputText = JSON.stringify(input);
  const manifest: Manifest = { version: 1, state: "prepared", config, promptVersion: coreMessagePromptVersion, inputHash: digest(inputText), fixtureId: fixture.id, evaluationProfile: fixture.evaluationProfile, networkRequests: 0 };
  writeExclusive(join(root, "input.json"), input);
  writeExclusive(join(root, "manifest.json"), manifest);
  return manifest;
}

function sourcesFromInput(input: ReturnType<typeof buildCoreMessagePromptInput>): CoreMessageSource[] {
  return input.sources.map((source) => ({ id: source.id, authority: source.authority, url: "https://local.invalid/not-transferred", material: source.material, boundary: source.evidenceBoundary }));
}

function genericPrecheck(hypothesis: { coreMessage: string; positioningThesis: string; audience: string; audienceSituation: string; audienceRecognition: string; mechanism: string; humanPayoff: string }) {
  const sloganWords = hypothesis.coreMessage.trim().split(/\s+/).length;
  const checks = [
    { name: "slogan_length", passed: sloganWords <= 12, detail: `Slogan contains ${sloganWords} words; at most 12 are allowed.` },
    { name: "thesis_slogan_separation", passed: hypothesis.positioningThesis.length > hypothesis.coreMessage.length, detail: "The explanatory thesis remains distinct from the slogan." },
    { name: "audience_recognition", passed: Boolean(hypothesis.audience && hypothesis.audienceSituation && hypothesis.audienceRecognition), detail: "Names an audience, its situation, and why it should recognize itself." },
    { name: "causal_value", passed: Boolean(hypothesis.mechanism && hypothesis.humanPayoff), detail: "Preserves a product mechanism and human payoff outside the slogan." },
  ];
  const passed = checks.filter((check) => check.passed).length;
  return { classification: passed === checks.length ? "strong" : passed >= 3 ? "acceptable" : "insufficient", eligibleForHumanReview: passed >= 3, checks, hardFailures: [] as string[] };
}

function evaluateHypothesis(profile: Manifest["evaluationProfile"], hypothesis: Parameters<typeof genericPrecheck>[0]) {
  return profile === "apidog_change_propagation"
    ? precheckCoreMessage(`${hypothesis.positioningThesis} ${hypothesis.coreMessage} ${hypothesis.humanPayoff}`)
    : genericPrecheck(hypothesis);
}

function outputText(response: unknown) {
  const envelope = z.object({
    model: z.string().optional(), status: z.string().optional(), output_text: z.string().min(1).optional(),
    usage: z.object({ input_tokens: z.number().int().nonnegative(), output_tokens: z.number().int().nonnegative() }),
    output: z.array(z.object({ type: z.string(), content: z.array(z.object({ type: z.string(), text: z.string().optional() })).optional() })).optional(),
  }).parse(response);
  const text = envelope.output_text ?? envelope.output?.flatMap((item) => item.type === "message" ? (item.content ?? []).filter((part) => part.type === "output_text").map((part) => part.text ?? "") : []).join("");
  if (!text) throw new CoreMessageLiveStop("MISSING_OUTPUT_TEXT");
  return { ...envelope, output_text: text };
}

export async function runCoreMessageLiveSession(root: string, apiKey: string, transport: Transport = fetch) {
  const manifestPath = join(root, "manifest.json");
  const manifest = readJson<Manifest>(manifestPath);
  if (manifest.state !== "prepared" || manifest.networkRequests !== 0) throw new CoreMessageLiveStop("SESSION_NOT_RUNNABLE");
  const input = readJson<ReturnType<typeof buildCoreMessagePromptInput>>(join(root, "input.json"));
  if (digest(JSON.stringify(input)) !== manifest.inputHash) throw new CoreMessageLiveStop("INPUT_TAMPERED");
  manifest.state = "dispatched";
  writeReplace(manifestPath, manifest);
  const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  const prompt = [{ role: "system", content: coreMessageSystemPrompt }, { role: "user", content: JSON.stringify(input) }];
  const sources = sourcesFromInput(input);
  try {
    const config = manifest.config;
    const deepSeek = config.provider === "deepseek";
    let maxOutputTokens: number;
    let reservedCostMicroUsd: number;
    let baseUrl: string;
    let reasoning: { effort: "low" | "high" } | undefined;
    let observedVersion: string | undefined;
    let accountingMethod: "context-window-reservation" | "exact-provider-count";
    if (config.provider === "deepseek") {
      maxOutputTokens = config.maxOutputTokens ?? 8_000;
      reservedCostMicroUsd = Math.ceil(config.contextWindowTokens * config.inputUsdPerMillion + maxOutputTokens * config.outputUsdPerMillion);
      if (reservedCostMicroUsd > 400_000) throw new CoreMessageLiveStop("COST_LIMIT");
      baseUrl = config.baseURL;
      reasoning = { effort: config.reasoningEffort };
      observedVersion = config.observedVersion;
      accountingMethod = "context-window-reservation";
    } else {
      maxOutputTokens = config.maxOutputTokens;
      const countResponse = await transport(`${config.baseUrl}/responses/input_tokens`, { method: "POST", headers, body: JSON.stringify({ model: config.model, input: prompt }), redirect: "error" });
      manifest.networkRequests += 1;
      writeReplace(manifestPath, manifest);
      if (!countResponse.ok) throw new CoreMessageLiveStop("INPUT_COUNT_FAILED");
      const count = z.object({ input_tokens: z.number().int().nonnegative() }).parse(await countResponse.json()).input_tokens;
      if (count > config.maxInputTokens) throw new CoreMessageLiveStop("INPUT_TOKEN_LIMIT");
      reservedCostMicroUsd = Math.ceil(count * config.inputMicroUsdPerMillionTokens / 1_000_000) + Math.ceil(maxOutputTokens * config.outputMicroUsdPerMillionTokens / 1_000_000);
      if (reservedCostMicroUsd > config.maxCostMicroUsd) throw new CoreMessageLiveStop("COST_LIMIT");
      baseUrl = config.baseUrl;
      reasoning = undefined;
      observedVersion = undefined;
      accountingMethod = "exact-provider-count";
    }
    const responseSchema = deepSeek ? deepSeekOutputSchema(coreMessageJsonSchema) : coreMessageJsonSchema;
    const response = await transport(`${baseUrl}/responses`, { method: "POST", headers, redirect: "error", body: JSON.stringify({ model: config.model, input: prompt, max_output_tokens: maxOutputTokens, store: false, ...(reasoning ? { reasoning } : {}), text: { format: { type: "json_schema", name: "core_message_proposal", ...(!deepSeek ? { strict: true } : {}), schema: responseSchema } } }) });
    manifest.networkRequests += 1;
    writeReplace(manifestPath, manifest);
    const responseBody = await response.text();
    if (!response.ok) {
      let diagnostic: unknown = { httpStatus: response.status };
      try {
        const parsed = z.object({ error: z.object({ type: z.string().optional(), code: z.string().nullable().optional(), message: z.string().max(1_000).optional(), param: z.string().nullable().optional() }).optional() }).parse(JSON.parse(responseBody));
        diagnostic = { httpStatus: response.status, error: parsed.error };
      } catch { /* retain status-only diagnostic */ }
      writeExclusive(join(root, "failure.json"), diagnostic);
      throw new CoreMessageLiveStop("GENERATION_FAILED");
    }
    const responseJson = JSON.parse(responseBody) as { status?: unknown; incomplete_details?: { reason?: unknown }; usage?: { input_tokens?: unknown; output_tokens?: unknown; output_tokens_details?: { reasoning_tokens?: unknown } }; output?: Array<{ type?: unknown; status?: unknown }> };
    if (responseJson.status && responseJson.status !== "completed") {
      writeExclusive(join(root, "failure.json"), {
        code: "PROVIDER_NOT_COMPLETED",
        providerStatus: responseJson.status,
        incompleteReason: responseJson.incomplete_details?.reason,
        usage: responseJson.usage,
        outputItems: responseJson.output?.map((item) => ({ type: item.type, status: item.status })),
      });
      throw new CoreMessageLiveStop("PROVIDER_NOT_COMPLETED");
    }
    const safe = outputText(responseJson);
    if (safe.model && safe.model !== config.model) throw new CoreMessageLiveStop("PROVIDER_BOUND_MISMATCH");
    const actualCostMicroUsd = config.provider === "deepseek"
      ? Math.ceil(safe.usage.input_tokens * config.inputUsdPerMillion + safe.usage.output_tokens * config.outputUsdPerMillion)
      : Math.ceil(safe.usage.input_tokens * config.inputMicroUsdPerMillionTokens / 1_000_000) + Math.ceil(safe.usage.output_tokens * config.outputMicroUsdPerMillionTokens / 1_000_000);
    writeExclusive(join(root, "candidate.json"), { model: config.model, observedVersion, usage: safe.usage, outputText: safe.output_text });
    let proposal;
    let normalizations: string[] = [];
    try {
      ({ proposal, normalizations } = parseCoreMessageProposalText(safe.output_text, sources));
    } catch (error) {
      const detail = error instanceof z.ZodError
        ? error.issues.map((issue) => ({ path: issue.path, code: issue.code, message: issue.message }))
        : [{ message: error instanceof Error ? error.message : "Unknown output validation error" }];
      writeExclusive(join(root, "failure.json"), { code: "OUTPUT_VALIDATION_FAILED", detail });
      throw new CoreMessageLiveStop("OUTPUT_VALIDATION_FAILED");
    }
    const checks = proposal.hypotheses.map((hypothesis) => ({ id: hypothesis.id, result: evaluateHypothesis(manifest.evaluationProfile, hypothesis) }));
    const artifact = { status: "awaiting_human_review", provider: deepSeek ? "deepseek" : "openai", model: config.model, observedVersion, promptVersion: manifest.promptVersion, normalizations, accounting: { method: accountingMethod, reservedCostMicroUsd, actualCostMicroUsd }, usage: safe.usage, proposal, checks } as const;
    const outputHash = digest(JSON.stringify(artifact));
    writeExclusive(join(root, "output.json"), artifact);
    writeExclusive(join(root, "review.json"), { outputHash, reviewer: "", verdict: "pending", dimensions: { groundedness: null, mechanismClarity: null, differentiation: null, decisionUsefulness: null }, preservedCoreJudgment: "", notes: "" });
    manifest.state = "awaiting_human_review";
    writeReplace(manifestPath, manifest);
    return { status: manifest.state, outputHash, networkRequests: manifest.networkRequests };
  } catch (error) {
    manifest.state = "failed";
    writeReplace(manifestPath, manifest);
    throw error;
  }
}

export function verifyCoreMessageReview(root: string) {
  const output = readFileSync(join(root, "output.json"), "utf8");
  const review = readJson<{ outputHash: string; reviewer: string; verdict: string; dimensions: Record<string, number | null>; preservedCoreJudgment: string; notes: string }>(join(root, "review.json"));
  if (review.outputHash !== digest(JSON.stringify(JSON.parse(output)))) throw new CoreMessageLiveStop("REVIEW_OUTPUT_HASH_MISMATCH");
  const scores = Object.values(review.dimensions);
  const complete = review.reviewer.trim().length > 0 && review.notes.trim().length > 0 && scores.length === 4 && scores.every((score) => Number.isInteger(score) && score! >= 0 && score! <= 4);
  if (!complete || !["pass", "fail"].includes(review.verdict)) return { accepted: false, reason: "REVIEW_INCOMPLETE" };
  const mean = (scores as number[]).reduce((sum, score) => sum + score, 0) / scores.length;
  const accepted = review.verdict === "pass" && scores.every((score) => score! >= 2) && mean >= 3 && review.preservedCoreJudgment.trim().length > 0;
  return { accepted, mean, reason: accepted ? "HUMAN_GATE_PASSED" : "HUMAN_GATE_NOT_PASSED" };
}

export function reprocessCoreMessageCandidate(sourceRoot: string, targetRoot: string) {
  const sourceManifest = readJson<Manifest>(join(sourceRoot, "manifest.json"));
  if (sourceManifest.state !== "failed") throw new CoreMessageLiveStop("SOURCE_SESSION_NOT_FAILED");
  const input = readJson<ReturnType<typeof buildCoreMessagePromptInput>>(join(sourceRoot, "input.json"));
  if (digest(JSON.stringify(input)) !== sourceManifest.inputHash) throw new CoreMessageLiveStop("INPUT_TAMPERED");
  const candidate = readJson<{ model: string; observedVersion?: string; usage: { input_tokens: number; output_tokens: number }; outputText: string }>(join(sourceRoot, "candidate.json"));
  if (candidate.model !== sourceManifest.config.model) throw new CoreMessageLiveStop("PROVIDER_BOUND_MISMATCH");
  const { proposal, normalizations } = parseCoreMessageProposalText(candidate.outputText, sourcesFromInput(input));
  const checks = proposal.hypotheses.map((hypothesis) => ({ id: hypothesis.id, result: evaluateHypothesis(sourceManifest.evaluationProfile, hypothesis) }));
  const config = sourceManifest.config;
  const deepSeek = config.provider === "deepseek";
  const reservedCostMicroUsd = deepSeek
    ? Math.ceil(config.contextWindowTokens * config.inputUsdPerMillion + 8_000 * config.outputUsdPerMillion)
    : 0;
  const actualCostMicroUsd = deepSeek
    ? Math.ceil(candidate.usage.input_tokens * config.inputUsdPerMillion + candidate.usage.output_tokens * config.outputUsdPerMillion)
    : Math.ceil(candidate.usage.input_tokens * config.inputMicroUsdPerMillionTokens / 1_000_000) + Math.ceil(candidate.usage.output_tokens * config.outputMicroUsdPerMillionTokens / 1_000_000);
  const artifact = { status: "awaiting_human_review", provider: deepSeek ? "deepseek" : "openai", model: config.model, observedVersion: candidate.observedVersion, promptVersion: sourceManifest.promptVersion, normalizations, accounting: { method: deepSeek ? "context-window-reservation" : "exact-provider-count", reservedCostMicroUsd, actualCostMicroUsd }, usage: candidate.usage, proposal, checks } as const;
  const outputHash = digest(JSON.stringify(artifact));
  mkdirSync(targetRoot, { recursive: false, mode: 0o700 });
  writeExclusive(join(targetRoot, "input.json"), input);
  writeExclusive(join(targetRoot, "candidate.json"), candidate);
  writeExclusive(join(targetRoot, "output.json"), artifact);
  writeExclusive(join(targetRoot, "review.json"), { outputHash, reviewer: "", verdict: "pending", dimensions: { groundedness: null, mechanismClarity: null, differentiation: null, decisionUsefulness: null }, preservedCoreJudgment: "", notes: "" });
  const manifest: Manifest = { ...sourceManifest, state: "awaiting_human_review", networkRequests: 0, derivedFromCandidateHash: digest(JSON.stringify(candidate)) };
  writeExclusive(join(targetRoot, "manifest.json"), manifest);
  return { status: manifest.state, outputHash, networkRequests: 0, derivedFromCandidateHash: manifest.derivedFromCandidateHash };
}

export function resolveSession(path: string) { return resolve(path); }
