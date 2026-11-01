import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { z } from "zod";

const whole = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positive = whole.refine(value => value > 0);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().min(1).max(160);
const endpoint = z.url().refine(value => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname.endsWith("/responses");
});
export const providerBudgetPolicySchema = z.object({
  schemaVersion: z.literal(1), acceptanceId: z.string().uuid(), projectId: identifier,
  caseHash: hash, sourceHash: hash, provider: identifier, model: identifier, observedVersion: identifier, endpoint,
  approval: z.object({ evidenceRef: identifier, approvedAt: z.iso.datetime(), validUntil: z.iso.datetime() }).strict(),
  pricing: z.object({ source: z.url(), checkedAt: z.iso.datetime(), validUntil: z.iso.datetime(), inputMicroUsdPerMillion: whole, outputMicroUsdPerMillion: whole }).strict(),
  limits: z.object({ requests: positive, inputTokens: positive, outputTokens: positive, microUsd: positive,
    inputTokensPerRequest: positive, outputTokensPerRequest: positive,
    requestMs: positive.max(2_147_483_647), modelActiveMs: positive,
    requestBytes: positive.max(16_777_216), responseBytes: positive.max(16_777_216), ledgerBytes: positive.max(1_000_000),
  }).strict(),
}).strict();
export type ProviderBudgetPolicy = z.infer<typeof providerBudgetPolicySchema>;
export const providerBudgetOperationSchema = z.object({
  acceptanceId: z.string().uuid(), sessionId: z.string().uuid(), projectId: identifier, caseHash: hash, sourceHash: hash,
  stage: z.enum(["understanding", "clarify", "positioning", "story", "legacy_deck"]), commandId: identifier,
}).strict();
export type ProviderBudgetOperation = z.infer<typeof providerBudgetOperationSchema>;
const reservationSchema = providerBudgetOperationSchema.extend({ callId: z.string().uuid(), requestHash: hash,
  inputTokens: whole, outputTokens: whole, microUsd: whole, modelActiveMs: whole,
}).strict();
const settlementSchema = z.object({ callId: z.string().uuid(), inputTokens: whole, outputTokens: whole, microUsd: whole,
  modelActiveMs: whole, observedModel: identifier, httpStatus: z.number().int().min(100).max(599),
}).strict();
const eventSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("initialized"), policy: providerBudgetPolicySchema }).strict(),
  z.object({ kind: z.literal("reserved"), reservation: reservationSchema }).strict(),
  z.object({ kind: z.literal("settled"), settlement: settlementSchema }).strict(),
  z.object({ kind: z.literal("unknown"), callId: z.string().uuid(), reason: z.enum(["transport", "deadline", "response", "usage", "model"]) }).strict(),
]);
const entryBodySchema = z.object({ sequence: whole, previous: hash, at: z.iso.datetime(), event: eventSchema }).strict();
const entrySchema = entryBodySchema.extend({ hash }).strict();
type Entry = z.infer<typeof entrySchema>;
type Reservation = z.infer<typeof reservationSchema>;
type Settlement = z.infer<typeof settlementSchema>;
type Call = { reservation: Reservation; outcome: { kind: "pending" } | { kind: "unknown" } | { kind: "settled"; value: Settlement } };
const seed = "0".repeat(64);
const terminalAllowance = 2048;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export class ProviderBudgetError extends Error {
  constructor(readonly code: string) { super(code); this.name = "ProviderBudgetError"; }
}
function fail(code: string): never { throw new ProviderBudgetError(code); }
const errorCode = (value: unknown) => z.object({ code: z.string() }).safeParse(value).data?.code;

function unlinked(path: string) {
  for (let current = resolve(path); ; current = dirname(current)) {
    try { if (lstatSync(current).isSymbolicLink()) fail("BUDGET_SYMLINK"); }
    catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
    if (current === dirname(current)) break;
  }
}
function privatePath(path: string, directory: boolean) {
  unlinked(path);
  const stat = lstatSync(path);
  if ((directory ? !stat.isDirectory() : !stat.isFile()) || (stat.mode & 0o077) !== 0) fail("BUDGET_INSECURE_PATH");
}
function livePolicy(policy: ProviderBudgetPolicy, now: number) {
  if (!Number.isSafeInteger(now) || now < Date.parse(policy.approval.approvedAt) || now >= Date.parse(policy.approval.validUntil)) fail("BUDGET_APPROVAL_EXPIRED");
  if (now < Date.parse(policy.pricing.checkedAt) || now >= Date.parse(policy.pricing.validUntil)) fail("BUDGET_PRICING_EXPIRED");
}
function makeEntry(entries: Entry[], event: z.infer<typeof eventSchema>, now: number): Entry {
  const body = entryBodySchema.parse({ sequence: entries.length, previous: entries.at(-1)?.hash ?? seed, at: new Date(now).toISOString(), event });
  return { ...body, hash: digest(body) };
}
function append(path: string, entry: Entry) {
  const fd = openSync(path, "a");
  try { appendFileSync(fd, JSON.stringify(entry) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
}
function project(entries: Entry[]) {
  const first = entries[0];
  if (!first || first.event.kind !== "initialized") return fail("BUDGET_UNINITIALIZED");
  const calls = new Map<string, Call>();
  for (const [index, entry] of entries.entries()) {
    const { hash: actual, ...body } = entry;
    if (entry.sequence !== index || entry.previous !== (entries[index - 1]?.hash ?? seed) || digest(body) !== actual) fail("BUDGET_JOURNAL_CHANGED");
    const event = entry.event;
    if (event.kind === "initialized") { if (index !== 0) fail("BUDGET_REINITIALIZED"); continue; }
    if (event.kind === "reserved") {
      if (calls.has(event.reservation.callId)) fail("BUDGET_DUPLICATE_CALL");
      calls.set(event.reservation.callId, { reservation: event.reservation, outcome: { kind: "pending" } });
    } else {
      const call = calls.get(event.kind === "settled" ? event.settlement.callId : event.callId);
      if (!call || call.outcome.kind !== "pending") fail("BUDGET_INVALID_OUTCOME");
      call.outcome = event.kind === "settled" ? { kind: "settled", value: event.settlement } : { kind: "unknown" };
    }
  }
  const used = { requests: calls.size, inputTokens: 0, outputTokens: 0, microUsd: 0, modelActiveMs: 0 };
  for (const call of calls.values()) {
    const amount = call.outcome.kind === "settled" ? call.outcome.value : call.reservation;
    for (const key of ["inputTokens", "outputTokens", "microUsd", "modelActiveMs"] satisfies (keyof typeof amount)[]) {
      used[key] += amount[key]; if (!Number.isSafeInteger(used[key])) fail("BUDGET_INVALID_TOTAL");
    }
  }
  return { policy: first.event.policy, calls, used };
}
function load(directory: string, policyHash: string) {
  privatePath(directory, true);
  const path = join(directory, "provider.jsonl"); privatePath(path, false);
  if (lstatSync(path).size > 1_000_000) fail("BUDGET_LEDGER_LIMIT");
  const bytes = readFileSync(path, "utf8");
  if (!bytes.endsWith("\n")) fail("BUDGET_PARTIAL_WRITE");
  const entries = bytes.slice(0, -1).split("\n").map(line => entrySchema.parse(JSON.parse(line)));
  const state = project(entries);
  if (digest(state.policy) !== policyHash) fail("BUDGET_POLICY_CHANGED");
  return { ...state, entries, path, bytes: Buffer.byteLength(bytes) };
}
function locked<T>(directory: string, action: () => T): T {
  privatePath(directory, true);
  const lock = join(directory, ".provider-lock");
  try { mkdirSync(lock, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) === "EEXIST") fail("BUDGET_BUSY"); throw error; }
  try { return action(); } finally { rmdirSync(lock); }
}
function cost(policy: ProviderBudgetPolicy, input: number, output: number) {
  const amount = (BigInt(input) * BigInt(policy.pricing.inputMicroUsdPerMillion) + BigInt(output) * BigInt(policy.pricing.outputMicroUsdPerMillion) + 999_999n) / 1_000_000n;
  if (amount > BigInt(Number.MAX_SAFE_INTEGER)) return fail("BUDGET_INVALID_COST");
  return Number(amount);
}

/** Operator-owned local ledger. The approval record is an auditable claim, not proof of consent. */
export function initializeProviderBudget(root: string, rawPolicy: unknown, now = Date.now()) {
  const policy = providerBudgetPolicySchema.parse(rawPolicy); livePolicy(policy, now);
  privatePath(root, true);
  const directory = join(root, policy.acceptanceId); unlinked(directory);
  try { mkdirSync(directory, { mode: 0o700 }); }
  catch (error) { if (errorCode(error) === "EEXIST") fail("BUDGET_ALREADY_EXISTS"); throw error; }
  const entry = makeEntry([], { kind: "initialized", policy }, now), bytes = JSON.stringify(entry) + "\n";
  if (Buffer.byteLength(bytes) + terminalAllowance > policy.limits.ledgerBytes) fail("BUDGET_LEDGER_LIMIT");
  writeFileSync(join(directory, "provider.jsonl"), bytes, { flag: "wx", mode: 0o600 });
  const fd = openSync(join(directory, "provider.jsonl"), "r"); try { fsyncSync(fd); } finally { closeSync(fd); }
  return { directory, policyHash: digest(policy) };
}
export function inspectProviderBudget(directory: string, policyHash: string) {
  const state = load(directory, policyHash);
  return { policy: state.policy, used: state.used, calls: [...state.calls.values()], bytes: state.bytes,
    state: [...state.calls.values()].some(call => call.outcome.kind === "unknown") ? "held_unknown" : [...state.calls.values()].some(call => call.outcome.kind === "pending") ? "pending" : "ready" };
}

export function budgetedProviderFetch(input: { directory: string; policyHash: string; operation: ProviderBudgetOperation; transport: typeof fetch; now?: () => number }): typeof fetch {
  const operation = providerBudgetOperationSchema.parse(input.operation), now = input.now ?? Date.now;
  return async (url, init) => {
    const started = now(), state = load(input.directory, input.policyHash), policy = state.policy;
    livePolicy(policy, started);
    if (init?.signal?.aborted) fail("BUDGET_ABORTED");
    if (operation.acceptanceId !== policy.acceptanceId || operation.projectId !== policy.projectId || operation.caseHash !== policy.caseHash || operation.sourceHash !== policy.sourceHash) fail("BUDGET_BINDING_MISMATCH");
    if (url instanceof Request || String(url) !== policy.endpoint || init?.method !== "POST" || typeof init.body !== "string") fail("BUDGET_UNEXPECTED_REQUEST");
    if (Buffer.byteLength(init.body) > policy.limits.requestBytes) fail("BUDGET_REQUEST_BYTES");
    const body = z.object({ model: identifier, max_output_tokens: positive.optional(), stream: z.literal(false).optional(), previous_response_id: z.never().optional(), conversation: z.never().optional(), background: z.literal(false).optional() }).passthrough().parse(JSON.parse(init.body));
    if (body.model !== policy.model || (body.max_output_tokens !== undefined && body.max_output_tokens > policy.limits.outputTokensPerRequest)) fail("BUDGET_REQUEST_MODEL_OR_OUTPUT");
    const outputTokens = body.max_output_tokens ?? policy.limits.outputTokensPerRequest;
    const requestBody = { ...body, max_output_tokens: outputTokens, store: false };
    const requestText = JSON.stringify(requestBody);
    if (Buffer.byteLength(requestText) > policy.limits.requestBytes) fail("BUDGET_REQUEST_BYTES");
    const reservation = reservationSchema.parse({ ...operation, callId: randomUUID(), requestHash: digest(requestBody), inputTokens: policy.limits.inputTokensPerRequest,
      outputTokens, microUsd: cost(policy, policy.limits.inputTokensPerRequest, outputTokens), modelActiveMs: policy.limits.requestMs });
    locked(input.directory, () => {
      const current = load(input.directory, input.policyHash); livePolicy(current.policy, now());
      if ([...current.calls.values()].some(call => call.outcome.kind === "unknown")) fail("BUDGET_UNKNOWN_OUTCOME");
      if ([...current.calls.values()].some(call => call.outcome.kind === "pending")) fail("BUDGET_BUSY");
      if (current.used.requests >= policy.limits.requests) fail("BUDGET_REQUEST_LIMIT");
      for (const key of ["inputTokens", "outputTokens", "microUsd", "modelActiveMs"] satisfies (keyof typeof current.used)[]) {
        if (reservation[key] > policy.limits[key] - current.used[key]) fail("BUDGET_LIMIT");
      }
      const entry = makeEntry(current.entries, { kind: "reserved", reservation }, now());
      if (current.bytes + Buffer.byteLength(JSON.stringify(entry) + "\n") + terminalAllowance > policy.limits.ledgerBytes) fail("BUDGET_LEDGER_LIMIT");
      append(current.path, entry);
    });
    const controller = new AbortController();
    const signal = init.signal ? AbortSignal.any([controller.signal, init.signal]) : controller.signal;
    let reason: "transport" | "deadline" | "response" | "usage" | "model" = "transport";
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => { reason = "deadline"; controller.abort(); reject(new ProviderBudgetError("BUDGET_DEADLINE")); }, policy.limits.requestMs);
    });
    try {
      const received = await Promise.race([(async () => {
        const response = await input.transport(url, { ...init, body: requestText, redirect: "error", signal });
        reason = "response";
        const reader = response.body?.getReader(); if (!reader) return fail("BUDGET_RESPONSE_EMPTY");
        const chunks: Uint8Array[] = []; let bytes = 0;
        try { for (;;) { const part = await reader.read(); if (part.done) break; bytes += part.value.byteLength; if (bytes > policy.limits.responseBytes) fail("BUDGET_RESPONSE_BYTES"); chunks.push(part.value); } }
        finally { await reader.cancel(); }
        const text = Buffer.concat(chunks).toString("utf8"); reason = "usage";
        const parsed = z.object({ model: identifier, usage: z.object({ input_tokens: whole, output_tokens: whole }).passthrough() }).passthrough().parse(JSON.parse(text));
        if (parsed.usage.input_tokens > reservation.inputTokens || parsed.usage.output_tokens > reservation.outputTokens) fail("BUDGET_USAGE_BOUND");
        reason = "model"; if (parsed.model !== policy.model) fail("BUDGET_MODEL_MISMATCH");
        return { response, text, parsed };
      })(), deadline]);
      const settlement = settlementSchema.parse({ callId: reservation.callId, inputTokens: received.parsed.usage.input_tokens, outputTokens: received.parsed.usage.output_tokens,
        microUsd: cost(policy, received.parsed.usage.input_tokens, received.parsed.usage.output_tokens), modelActiveMs: Math.min(policy.limits.requestMs, Math.max(0, now() - started)),
        observedModel: received.parsed.model, httpStatus: received.response.status });
      locked(input.directory, () => {
        const current = load(input.directory, input.policyHash);
        const entry = makeEntry(current.entries, { kind: "settled", settlement }, now());
        if (current.bytes + Buffer.byteLength(JSON.stringify(entry) + "\n") > policy.limits.ledgerBytes) fail("BUDGET_LEDGER_LIMIT");
        append(current.path, entry);
      });
      return new Response(received.text, { status: received.response.status, headers: { "content-type": "application/json" } });
    } catch (error) {
      // If recording fails, the original durable pending reservation still prevents a second dispatch.
      locked(input.directory, () => {
        const current = load(input.directory, input.policyHash);
        const call = current.calls.get(reservation.callId);
        if (call?.outcome.kind === "pending") append(current.path, makeEntry(current.entries, { kind: "unknown", callId: reservation.callId, reason }, now()));
      });
      throw error;
    } finally { if (timer) clearTimeout(timer); }
  };
}
