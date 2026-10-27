import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { assertUnlinkedPath, ensurePrivateDirectory, evidenceTreeBytes, failEvidence, reserveEvidenceWrite, withEvidenceLock, type EvidencePolicy } from "./capacity";
import { freezeBindingSchema, hashTaskBytes, hashTaskValue, parseTaskBundle, productCheckpointPayloadSchema, sha256Schema, taskStageSchema } from "./schema";

const text = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const sessionIdSchema = z.string().uuid();
const json = z.json();
const sourceIdentitySchema = z.object({
  head: z.string().regex(/^[a-f0-9]{40,64}$/), dirty: z.boolean(),
  files: z.array(z.object({ path: text, hash: sha256Schema }).strict()).min(2), lockfileHash: sha256Schema,
}).strict().superRefine((source, context) => {
  const lock = source.files.find(item => item.path === "pitchroom-app/pnpm-lock.yaml");
  if (!lock || lock.hash !== source.lockfileHash || new Set(source.files.map(item => item.path)).size !== source.files.length || !source.files.some(item => /\.[cm]?[jt]sx?$/.test(item.path))) context.addIssue({ code: "custom", message: "Source identity needs unique code receipts and the matching lockfile hash." });
});
const buildIdentitySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), buildId: text, sourceFingerprint: sha256Schema, evidenceRef: text }).strict(),
  z.object({ kind: z.literal("unknown"), reason: text }).strict(),
]);
export const taskRuntimeIdentitySchema = z.object({ web: buildIdentitySchema, worker: buildIdentitySchema }).strict();
const identitySchema = z.object({ source: sourceIdentitySchema, runtime: taskRuntimeIdentitySchema }).strict();
const bundleInputSchema = z.object({ taskCase: z.unknown(), oracle: z.unknown(), materialPackageText: z.string() }).strict();
// Persist transport status/identifiers, never raw provider envelopes. Product bodies belong in result.
export const taskTransportSummarySchema = z.object({
  kind: z.literal("transport_summary"),
  status: z.enum(["not_dispatched", "received", "error", "outcome_unknown"]),
  httpStatus: z.number().int().min(100).max(599).nullable(),
  providerStatus: z.string().regex(/^[A-Za-z0-9_.-]{1,200}$/).nullable(),
  observedModel: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,199}$/).nullable(),
}).strict();
export const originalBodyDigestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("known"), sha256: sha256Schema, scope: z.literal("body_bytes_before_projection"), evidenceRef: text }).strict(),
  z.object({ kind: z.literal("unknown"), reason: text }).strict(),
]);
export const checkpointInputSchema = z.object({
  stage: taskStageSchema, attemptId: text, commandId: text, projectId: text, revision: z.number().int().nonnegative(),
  startedAt: timestamp, endedAt: timestamp, parentCheckpointHashes: z.array(sha256Schema),
  versionIds: z.object({ understanding: text.nullable(), positioning: text.nullable(), story: text.nullable(), deck: text.nullable() }).strict(),
  model: text, promptVersion: text, runtime: taskRuntimeIdentitySchema,
  usage: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("known"), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).strict(),
    z.object({ kind: z.literal("unknown"), reason: text }).strict(),
  ]),
  request: json, response: taskTransportSummarySchema,
  originalBodyDigests: z.object({ request: originalBodyDigestSchema, response: originalBodyDigestSchema }).strict(),
  result: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("product_output"), data: productCheckpointPayloadSchema }).strict(),
    z.object({ kind: z.literal("unverified_record"), data: json }).strict(),
    z.object({ kind: z.literal("failed"), reason: text }).strict(),
    z.object({ kind: z.literal("outcome_unknown"), reason: text }).strict(),
  ]),
}).strict().superRefine((input, context) => {
  if (Date.parse(input.endedAt) < Date.parse(input.startedAt)) context.addIssue({ code: "custom", message: "A checkpoint cannot end before it starts." });
  if (input.result.kind === "product_output" && input.result.data.stage !== input.stage) context.addIssue({ code: "custom", message: "Product payload must match its recorded stage." });
  if (new Set(input.parentCheckpointHashes).size !== input.parentCheckpointHashes.length) context.addIssue({ code: "custom", message: "Parent checkpoint references must be unique." });
});
const checkpointSchema = z.object({ schemaVersion: z.literal(1), input: checkpointInputSchema, storedRequestHash: sha256Schema, storedResponseSummaryHash: sha256Schema, storedResultHash: sha256Schema }).strict();
const observationSchema = z.object({ id: text, at: timestamp, stage: taskStageSchema, attemptId: text.nullable(), commandId: text.nullable(), checkpointHash: sha256Schema.nullable(), kind: z.enum(["observation", "failure", "review_record"]), data: json }).strict();
const manifestSchema = z.object({
  schemaVersion: z.literal(1), sessionId: sessionIdSchema, purpose: z.enum(["tool_validation", "task_evidence"]), createdAt: timestamp, maximumBytes: z.number().int().positive(),
  binding: freezeBindingSchema, bundleHash: sha256Schema, identity: identitySchema, policyHash: sha256Schema,
}).strict();
const eventSchema = z.object({
  sequence: z.number().int().positive(), previous: sha256Schema.nullable(), at: timestamp,
  kind: z.enum(["initialize", "checkpoint", "observation", "failure", "review_record"]), objectHash: sha256Schema,
  digest: sha256Schema,
}).strict();
export const taskSessionRefSchema = z.object({
  sessionId: sessionIdSchema, manifestHash: sha256Schema, sequence: z.number().int().positive(), headHash: sha256Schema,
}).strict();
export type TaskSessionRef = z.infer<typeof taskSessionRefSchema>;
const dirs = ["inputs", "events", "checkpoints", "observations", "failures", "reviews", "claim-audit", "verdict"];
const encode = (value: unknown) => `${JSON.stringify(value)}\n`;
const readJson = (path: string): unknown => { assertUnlinkedPath(path); return JSON.parse(readFileSync(path, "utf8")); };
const eventName = (sequence: number) => `${String(sequence).padStart(12, "0")}.json`;
const rootFor = (policy: EvidencePolicy, sessionId: string) => {
  const root = join(policy.recordRoot, sessionIdSchema.parse(sessionId)); assertUnlinkedPath(root); return root;
};

function rejectSensitive(value: unknown, secrets: readonly string[]) {
  const parsed = json.parse(value);
  const visit = (item: z.infer<typeof json>): void => {
    if (Array.isArray(item)) { item.forEach(visit); return; }
    if (item !== null && typeof item === "object") {
      if (typeof item.type === "string" && /^(?:reasoning(?:_.*)?|thinking|redacted_thinking)$/i.test(item.type)) failEvidence("INTERNAL_REASONING_RECORD");
      for (const [key, nested] of Object.entries(item)) {
      if (/^(authorization|headers|api_?key|password|access_?token|encrypted_content|reasoning|reasoning_content|chain_of_thought)$/i.test(key)) failEvidence("SENSITIVE_RECORD_FIELD");
      visit(key); visit(nested);
      }
    }
    if (typeof item === "string" && (/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/.test(item) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(item) || /(?:postgres(?:ql)?|mongodb(?:\+srv)?):\/\/[^\s]+:[^\s]+@/.test(item) || secrets.some(secret => secret.length > 0 && item.includes(secret)))) failEvidence("SENSITIVE_RECORD_VALUE");
  };
  visit(parsed);
}

function publish(path: string, value: unknown) {
  assertUnlinkedPath(path);
  const bytes = encode(value);
  if (existsSync(path)) {
    if (readFileSync(path, "utf8") !== bytes) failEvidence("IMMUTABLE_RECORD_CONFLICT");
    return;
  }
  const temporary = join(resolve(path, ".."), `.pending-${randomUUID()}`);
  const fd = openSync(temporary, "wx", 0o600);
  try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  // link is atomic and never replaces an existing destination. Failed temporary files remain counted.
  linkSync(temporary, path);
  unlinkSync(temporary);
  const directory = openSync(resolve(path, ".."), "r");
  try { fsyncSync(directory); } finally { closeSync(directory); }
}
function makeEvent(sequence: number, previous: z.infer<typeof sha256Schema> | null, kind: z.infer<typeof eventSchema>["kind"], objectHash: z.infer<typeof sha256Schema>) {
  const event = { sequence, previous, at: new Date().toISOString(), kind, objectHash };
  return eventSchema.parse({ ...event, digest: hashTaskValue(event) });
}
function reserve(policy: EvidencePolicy, root: string, maximumBytes: number, values: unknown[]) {
  const additionalBytes = values.reduce<number>((sum, item) => sum + Buffer.byteLength(encode(item)), 0) * 2 + 4096;
  return reserveEvidenceWrite(policy, { additionalBytes, sessionRoot: root, maximumSessionBytes: maximumBytes });
}
function reference(manifestHash: z.infer<typeof sha256Schema>, sessionId: string, event: z.infer<typeof eventSchema>): TaskSessionRef {
  return { sessionId, manifestHash, sequence: event.sequence, headHash: event.digest };
}

export function captureTaskSourceIdentity(repository: string, paths: readonly string[]) {
  const root = realpathSync(repository);
  const selected = [...new Set([...paths, "pitchroom-app/pnpm-lock.yaml"])].sort();
  const files = selected.map(path => {
    if (!path.startsWith("pitchroom-app/") || path.split(/[\\/]/).some(part => ["", ".", "..", ".artifacts", "node_modules", "archive"].includes(part)) || /(?:\.env|credential|\.(?:db|sqlite|pem|key)$)/i.test(path)) failEvidence("INVALID_SOURCE_FINGERPRINT_PATH");
    const absolute = join(root, path); assertUnlinkedPath(absolute);
    return { path, hash: hashTaskBytes(readFileSync(absolute)) };
  });
  const lockfile = files.find(item => item.path === "pitchroom-app/pnpm-lock.yaml");
  if (!lockfile) failEvidence("MISSING_LOCKFILE_FINGERPRINT");
  return sourceIdentitySchema.parse({
    head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    dirty: execFileSync("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, encoding: "utf8" }).trim().length > 0,
    files, lockfileHash: lockfile.hash,
  });
}

export function createTaskSession(policy: EvidencePolicy, raw: unknown, secrets: readonly string[] = []) {
  const input = z.object({ sessionId: sessionIdSchema, purpose: z.enum(["tool_validation", "task_evidence"]), maximumBytes: z.number().int().positive(), identity: identitySchema, bundle: bundleInputSchema }).strict().parse(raw);
  const bundle = parseTaskBundle(input.bundle);
  if (bundle.taskCase.status !== "frozen") failEvidence("CASE_NOT_FROZEN");
  rejectSensitive(input, secrets);
  return withEvidenceLock(policy, () => {
    const root = rootFor(policy, input.sessionId);
    const manifestPath = join(root, "manifest.json");
    const manifest = existsSync(manifestPath) ? manifestSchema.parse(readJson(manifestPath)) : manifestSchema.parse({ schemaVersion: 1, sessionId: input.sessionId, purpose: input.purpose, maximumBytes: input.maximumBytes, createdAt: new Date().toISOString(), binding: bundle.binding, bundleHash: hashTaskValue(input.bundle), identity: input.identity, policyHash: policy.policyHash });
    if (manifest.sessionId !== input.sessionId || manifest.purpose !== input.purpose || manifest.maximumBytes !== input.maximumBytes || manifest.bundleHash !== hashTaskValue(input.bundle) || hashTaskValue(manifest.identity) !== hashTaskValue(input.identity) || hashTaskValue(manifest.binding) !== hashTaskValue(bundle.binding) || manifest.policyHash !== policy.policyHash) failEvidence("SESSION_INITIALIZATION_CONFLICT");
    const manifestHash = hashTaskValue(manifest);
    const firstPath = join(root, "events", eventName(1));
    const first = existsSync(firstPath) ? eventSchema.parse(readJson(firstPath)) : makeEvent(1, null, "initialize", manifest.bundleHash);
    if (first.sequence !== 1 || first.previous !== null || first.kind !== "initialize" || first.objectHash !== manifest.bundleHash) failEvidence("INVALID_SESSION_INITIALIZATION");
    const writes = [{ path: manifestPath, value: manifest }, { path: join(root, "inputs/bundle.json"), value: input.bundle }, { path: firstPath, value: first }];
    const missing = writes.filter(item => !existsSync(item.path));
    if (missing.length) reserve(policy, root, input.maximumBytes, missing.map(item => item.value));
    ensurePrivateDirectory(root);
    for (const name of dirs) ensurePrivateDirectory(join(root, name));
    publish(join(root, "manifest.json"), manifest);
    publish(join(root, "inputs/bundle.json"), input.bundle);
    publish(join(root, "events", eventName(1)), first);
    return verifyTaskSession(policy, reference(manifestHash, input.sessionId, first)).reference;
  });
}

export function verifyTaskSession(policy: EvidencePolicy, rawReference: unknown) {
  const expected = taskSessionRefSchema.parse(rawReference), root = rootFor(policy, expected.sessionId);
  const manifest = manifestSchema.parse(readJson(join(root, "manifest.json")));
  if (manifest.sessionId !== expected.sessionId || hashTaskValue(manifest) !== expected.manifestHash || manifest.policyHash !== policy.policyHash) failEvidence("SESSION_MANIFEST_MISMATCH");
  const bundleInput = bundleInputSchema.parse(readJson(join(root, "inputs/bundle.json")));
  if (hashTaskValue(bundleInput) !== manifest.bundleHash) failEvidence("SESSION_INPUT_TAMPERED");
  const bundle = parseTaskBundle(bundleInput);
  if (bundle.taskCase.status !== "frozen" || hashTaskValue(bundle.binding) !== hashTaskValue(manifest.binding)) failEvidence("SESSION_BINDING_MISMATCH");
  evidenceTreeBytes(root); // Reject symlinks/modes anywhere, including uncommitted or derived files.
  const checkpoints = new Map<string, { hash: z.infer<typeof sha256Schema>; value: z.infer<typeof checkpointSchema> }>();
  for (const name of readdirSync(join(root, "checkpoints"))) {
    if (name.startsWith(".pending-")) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) failEvidence("UNKNOWN_CHECKPOINT_FILE");
    const value = checkpointSchema.parse(readJson(join(root, "checkpoints", name)));
    const hash = hashTaskValue(value);
    if (`${hash}.json` !== name || hashTaskValue(value.input.request) !== value.storedRequestHash || hashTaskValue(value.input.response) !== value.storedResponseSummaryHash || hashTaskValue(value.input.result) !== value.storedResultHash) failEvidence("CHECKPOINT_TAMPERED");
    const prior = checkpoints.get(value.input.attemptId);
    if (prior && prior.hash !== hash) failEvidence("ATTEMPT_ID_CONFLICT");
    checkpoints.set(value.input.attemptId, { hash, value });
  }
  const observationObjects = new Map<string, { hash: z.infer<typeof sha256Schema>; value: z.infer<typeof observationSchema>; folder: string }>();
  for (const folder of ["observations", "failures", "reviews"]) for (const name of readdirSync(join(root, folder)).sort()) {
    if (name.startsWith(".pending-")) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(name)) failEvidence("UNKNOWN_OBSERVATION_FILE");
    const value = observationSchema.parse(readJson(join(root, folder, name))), hash = hashTaskValue(value);
    const expectedFolder = value.kind === "failure" ? "failures" : value.kind === "review_record" ? "reviews" : "observations";
    if (folder !== expectedFolder || `${hash}.json` !== name) failEvidence("OBSERVATION_TAMPERED");
    const prior = observationObjects.get(value.id);
    if (prior && prior.hash !== hash) failEvidence("OBSERVATION_ID_CONFLICT");
    observationObjects.set(value.id, { hash, value, folder });
  }
  const committedObservations = new Set<string>();
  const names = readdirSync(join(root, "events")).filter(name => !name.startsWith(".pending-")).sort();
  const events: z.infer<typeof eventSchema>[] = [], committed = new Set<string>(), observations: z.infer<typeof observationSchema>[] = [];
  let previous: z.infer<typeof sha256Schema> | null = null;
  for (const name of names) {
    if (name !== eventName(events.length + 1)) failEvidence("INVALID_JOURNAL_SEQUENCE");
    const event = eventSchema.parse(readJson(join(root, "events", name)));
    const { digest, ...body } = event;
    if (event.sequence !== events.length + 1 || event.previous !== previous || hashTaskValue(body) !== digest) failEvidence("INVALID_JOURNAL_HASH_CHAIN");
    if (events.length === 0) {
      if (event.kind !== "initialize" || event.objectHash !== manifest.bundleHash) failEvidence("INVALID_SESSION_INITIALIZATION");
    } else if (event.kind === "initialize") failEvidence("DUPLICATE_INITIALIZATION");
    else if (event.kind === "checkpoint") {
      const checkpoint = [...checkpoints.values()].find(item => item.hash === event.objectHash);
      if (!checkpoint || committed.has(event.objectHash) || checkpoint.value.input.parentCheckpointHashes.some(hash => !committed.has(hash))) failEvidence("INVALID_CHECKPOINT_REFERENCE");
      committed.add(event.objectHash);
    } else {
      const observation = [...observationObjects.values()].find(item => item.hash === event.objectHash);
      if (!observation || observation.value.kind !== event.kind || committedObservations.has(event.objectHash)) failEvidence("INVALID_OBSERVATION_REFERENCE");
      committedObservations.add(event.objectHash); observations.push(observation.value);
    }
    events.push(event); previous = event.digest;
  }
  const last = events.at(-1), anchor = events[expected.sequence - 1];
  if (!last || !anchor || anchor.digest !== expected.headHash) failEvidence("JOURNAL_ANCHOR_MISSING");
  const uncommittedFiles: string[] = [];
  const walk = (directory: string) => {
    for (const name of readdirSync(directory)) {
      const path = join(directory, name), st = lstatSync(path);
      if (st.isDirectory()) walk(path);
      else if (name.startsWith(".pending-")) uncommittedFiles.push(path.slice(root.length + 1));
    }
  };
  walk(root);
  for (const item of checkpoints.values()) if (!committed.has(item.hash)) uncommittedFiles.push(`checkpoints/${item.hash}.json`);
  for (const item of observationObjects.values()) if (!committedObservations.has(item.hash)) uncommittedFiles.push(`${item.folder}/${item.hash}.json`);
  uncommittedFiles.sort();
  return { reference: reference(expected.manifestHash, expected.sessionId, last), manifest, bundle, events, checkpoints, committed, observations, observationObjects, uncommittedFiles };
}

export function appendTaskCheckpoint(policy: EvidencePolicy, rawReference: unknown, rawInput: unknown, secrets: readonly string[] = []) {
  const expected = taskSessionRefSchema.parse(rawReference), input = checkpointInputSchema.parse(rawInput);
  rejectSensitive(input, secrets);
  const checkpoint = checkpointSchema.parse({ schemaVersion: 1, input, storedRequestHash: hashTaskValue(input.request), storedResponseSummaryHash: hashTaskValue(input.response), storedResultHash: hashTaskValue(input.result) });
  const objectHash = hashTaskValue(checkpoint);
  return withEvidenceLock(policy, () => {
    const state = verifyTaskSession(policy, expected), root = rootFor(policy, expected.sessionId);
    const prior = state.checkpoints.get(input.attemptId);
    if (prior && prior.hash !== objectHash) failEvidence("ATTEMPT_ID_CONFLICT");
    if (prior && state.committed.has(prior.hash)) return { reference: state.reference, checkpointHash: prior.hash, replayed: true };
    if (state.reference.headHash !== expected.headHash) failEvidence("SESSION_HEAD_CHANGED");
    if (input.parentCheckpointHashes.some(hash => !state.committed.has(hash))) failEvidence("UNKNOWN_PARENT_CHECKPOINT");
    const event = makeEvent(state.reference.sequence + 1, state.reference.headHash, "checkpoint", objectHash);
    reserve(policy, root, state.manifest.maximumBytes, [checkpoint, event]);
    publish(join(root, "checkpoints", `${objectHash}.json`), checkpoint);
    publish(join(root, "events", eventName(event.sequence)), event);
    return { reference: reference(expected.manifestHash, expected.sessionId, event), checkpointHash: objectHash, replayed: false };
  });
}

export function appendTaskObservation(policy: EvidencePolicy, rawReference: unknown, rawInput: unknown, secrets: readonly string[] = []) {
  const expected = taskSessionRefSchema.parse(rawReference), input = observationSchema.parse(rawInput);
  rejectSensitive(input, secrets);
  return withEvidenceLock(policy, () => {
    const state = verifyTaskSession(policy, expected), root = rootFor(policy, expected.sessionId);
    if (input.checkpointHash !== null && !state.committed.has(input.checkpointHash)) failEvidence("UNKNOWN_OBSERVATION_CHECKPOINT");
    const prior = state.observationObjects.get(input.id);
    if (prior && prior.hash !== hashTaskValue(input)) failEvidence("OBSERVATION_ID_CONFLICT");
    if (prior && state.observations.some(item => item.id === input.id)) return state.reference;
    if (state.reference.headHash !== expected.headHash) failEvidence("SESSION_HEAD_CHANGED");
    const hash = hashTaskValue(input), event = makeEvent(state.reference.sequence + 1, state.reference.headHash, input.kind, hash);
    reserve(policy, root, state.manifest.maximumBytes, [input, event]);
    const folder = input.kind === "failure" ? "failures" : input.kind === "review_record" ? "reviews" : "observations";
    publish(join(root, folder, `${hash}.json`), input);
    publish(join(root, "events", eventName(event.sequence)), event);
    return reference(expected.manifestHash, expected.sessionId, event);
  });
}

export function rebuildTaskLedgerReport(policy: EvidencePolicy, rawReference: unknown) {
  return withEvidenceLock(policy, () => {
    const state = verifyTaskSession(policy, rawReference), root = rootFor(policy, state.reference.sessionId);
    const report = { kind: "ledger_integrity_only", purpose: state.manifest.purpose, reference: state.reference, checkpointCount: state.committed.size, observationCount: state.observations.length, uncommittedFiles: state.uncommittedFiles, semantic: "not_evaluated", userTask: "not_observed" };
    const path = join(root, "verdict", `ledger-${state.reference.headHash}-${hashTaskValue(report)}.json`);
    if (!existsSync(path)) reserve(policy, root, state.manifest.maximumBytes, [report]);
    publish(path, report);
    return { path, report };
  });
}
