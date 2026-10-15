import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { sql } from "drizzle-orm";
import type { PositioningProposalV1, UnderstandingProposalV1 } from "@pitchroom/domain";
import { createDatabase, PitchroomRepository } from "./repository";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is required for persistence integration tests.");
const { client, db } = createDatabase(url);
const repository = new PitchroomRepository(db);

beforeAll(async () => {
  await migrate(db, { migrationsFolder: new URL("../migrations", import.meta.url).pathname });
  await db.execute(sql`truncate approvals, user_inputs, understanding_versions, agent_events, agent_runs, source_chunks, sources, projects cascade`);
});
afterAll(async () => client.end());

describe("PostgreSQL repository contract", () => {
  it("persists idempotent material and project-scoped chunks", async () => {
    const project = await repository.createProject("Integration project");
    const input = { name: "brief.md", mediaType: "text/markdown" as const, text: "Revenue grew 40 percent." };
    const first = await repository.addMaterial(project.id, input, "material-1");
    const second = await repository.addMaterial(project.id, input, "material-1");
    expect(second.id).toBe(first.id);
    const sameContentNewKey = await repository.addMaterial(project.id, input, "material-2");
    expect(sameContentNewKey.id).toBe(first.id);
    await expect(repository.addMaterial(project.id, { ...input, text: "Different material." }, "material-2")).rejects.toThrow("different material command");
    expect(await repository.listSources(project.id)).toHaveLength(1);
    const chunk = (await repository.listSources(project.id))[0]!.chunks[0]!;
    expect(await repository.getChunk(project.id, chunk.id)).toMatchObject({ text: "Revenue grew 40 percent." });
    const other = await repository.createProject("Other project");
    expect(await repository.getChunk(other.id, chunk.id)).toBeUndefined();
  });

  it("commits a version atomically and rejects stale writes", async () => {
    const project = await repository.createProject("Versioned project");
    await repository.addMaterial(project.id, { name: "brief.txt", mediaType: "text/plain", text: "Revenue grew 40 percent." }, "material-versioned");
    const source = (await repository.listSources(project.id))[0]!;
    const chunk = source.chunks[0]!;
    const run = await repository.createRun(project.id, "run-1", "understanding-v1", "fake");
    const proposal: UnderstandingProposalV1 = {
      schemaVersion: 1 as const,
      themes: [{ title: "Growth", summary: "Growth signal", claims: [{ statement: "Revenue grew 40 percent.", evidenceState: "supported" as const, evidence: [{ sourceId: source.id, chunkId: chunk.id, quote: "Revenue grew 40 percent." }], userInputIds: [] }] }],
      gaps: [],
      nextQuestion: { question: "What drove growth?", whyItMatters: "Tests durability", relatedThemeIndexes: [0] },
    };
    const understanding = await repository.completeRun({ projectId: project.id, runId: run.id, expectedRevision: 0, proposal });
    expect((await repository.getProject(project.id))?.phase).toBe("review_required");
    await expect(repository.completeRun({ projectId: project.id, runId: run.id, expectedRevision: 0, proposal })).rejects.toThrow("stale");

    const correctedProposal = structuredClone(proposal);
    correctedProposal.themes[0]!.claims[0] = { statement: "Finance owner says revenue grew 35 percent.", evidenceState: "user_asserted", evidence: [], userInputIds: ["pending-at-persistence-boundary"] };
    const userVersion = await repository.createUserVersion({ projectId: project.id, expectedRevision: 1, kind: "correction", text: correctedProposal.themes[0]!.claims[0]!.statement, actorId: "local-user", idempotencyKey: "input-1", proposal: correctedProposal });
    const duplicate = await repository.createUserVersion({ projectId: project.id, expectedRevision: 1, kind: "correction", text: correctedProposal.themes[0]!.claims[0]!.statement, actorId: "local-user", idempotencyKey: "input-1", proposal: correctedProposal });
    expect(duplicate.id).toBe(userVersion.id);
    expect(userVersion.createdBy).toBe("user");
    expect(userVersion.runId).toBeNull();
    await expect(repository.acceptUnderstanding({ projectId: project.id, understandingId: understanding.id, expectedRevision: 0, actorId: "local-user", idempotencyKey: "accept-stale" })).rejects.toThrow("current reviewed");
    const approval = await repository.acceptUnderstanding({ projectId: project.id, understandingId: userVersion.id, expectedRevision: 2, actorId: "local-user", idempotencyKey: "accept-1" });
    expect(approval?.decision).toBe("accepted");
    expect((await repository.getProject(project.id))?.phase).toBe("accepted");
  });

  it("enforces the aggregate project text limit without counting deduplicated content", async () => {
    const project = await repository.createProject("Bounded project");
    const bounded = new PitchroomRepository(db, 20);
    await bounded.addMaterial(project.id, { name: "one.txt", mediaType: "text/plain", text: "1234567890" }, "bounded-1");
    await bounded.addMaterial(project.id, { name: "same.txt", mediaType: "text/plain", text: "1234567890" }, "bounded-duplicate");
    await expect(bounded.addMaterial(project.id, { name: "two.txt", mediaType: "text/plain", text: "abcdefghijk" }, "bounded-2")).rejects.toThrow("project text limit");
    expect(await bounded.listSources(project.id)).toHaveLength(1);
  });

  it("persists cancellation distinctly and allows a new retry run", async () => {
    const project = await repository.createProject("Cancelled project");
    await repository.addMaterial(project.id, { name: "brief.txt", mediaType: "text/plain", text: "Evidence." }, "cancel-material");
    const first = await repository.createRun(project.id, "cancel-run-1", "v1", "fake");
    await repository.cancelRun({ projectId: project.id, runId: first.id, message: "user cancelled" });
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "cancelled" });
    const retry = await repository.createRun(project.id, "cancel-run-2", "v1", "fake");
    expect(retry.id).not.toBe(first.id);
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "reading" });
    await repository.failRun({ projectId: project.id, runId: retry.id, message: "provider failed" });
    const retryAfterFailure = await repository.createRun(project.id, "cancel-run-3", "v1", "fake");
    expect(retryAfterFailure.id).not.toBe(retry.id);
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "reading" });
  });

  it("invalidates reviewed understanding when new material is added", async () => {
    const project = await repository.createProject("Terminal material project");
    await repository.addMaterial(project.id, { name: "brief.txt", mediaType: "text/plain", text: "Revenue grew." }, "terminal-material-1");
    const source = (await repository.listSources(project.id))[0]!;
    const run = await repository.createRun(project.id, "terminal-run", "v1", "fake");
    const proposal: UnderstandingProposalV1 = {
      schemaVersion: 1,
      themes: [{ title: "Growth", summary: "Growth", claims: [{ statement: "Revenue grew.", evidenceState: "supported", evidence: [{ sourceId: source.id, chunkId: source.chunks[0]!.id, quote: "Revenue grew." }], userInputIds: [] }] }],
      gaps: [],
      nextQuestion: { question: "Why?", whyItMatters: "Review", relatedThemeIndexes: [0] },
    };
    await repository.completeRun({ projectId: project.id, runId: run.id, expectedRevision: 0, proposal });
    await repository.addMaterial(project.id, { name: "late.txt", mediaType: "text/plain", text: "Late." }, "terminal-material-2");
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "materials_ready", currentUnderstandingId: null });
    const rerun = await repository.createRun(project.id, "terminal-rerun", "v1", "fake");
    const secondUnderstanding = await repository.completeRun({ projectId: project.id, runId: rerun.id, expectedRevision: 1, proposal });
    await repository.acceptUnderstanding({ projectId: project.id, understandingId: secondUnderstanding.id, expectedRevision: 2, actorId: "local-user", idempotencyKey: "terminal-accept" });
    await repository.addMaterial(project.id, { name: "later.txt", mediaType: "text/plain", text: "Later." }, "terminal-material-3");
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "materials_ready", currentUnderstandingId: null });
  });

  it("serializes concurrent run creation and prevents stale terminal writes", async () => {
    const project = await repository.createProject("Concurrent run project");
    await repository.addMaterial(project.id, { name: "brief.txt", mediaType: "text/plain", text: "Evidence." }, "race-material");
    const attempts = await Promise.allSettled([
      repository.createRun(project.id, "race-run-1", "v1", "fake"),
      repository.createRun(project.id, "race-run-2", "v1", "fake"),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((attempt) => attempt.status === "rejected")).toHaveLength(1);
    const winner = attempts.find((attempt): attempt is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.createRun>>> => attempt.status === "fulfilled")!.value;
    await repository.cancelRun({ projectId: project.id, runId: winner.id, message: "cancel winner" });
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "cancelled" });
    await repository.failRun({ projectId: project.id, runId: winner.id, message: "late failure" });
    expect(await repository.getProject(project.id)).toMatchObject({ phase: "cancelled" });
  });

  it("coalesces concurrent replays with the same idempotency key", async () => {
    const project = await repository.createProject("Concurrent replay project");
    const materialInput = { name: "brief.txt", mediaType: "text/plain" as const, text: "Evidence." };
    const [firstMaterial, secondMaterial] = await Promise.all([
      repository.addMaterial(project.id, materialInput, "same-material-command"),
      repository.addMaterial(project.id, materialInput, "same-material-command"),
    ]);
    expect(secondMaterial.id).toBe(firstMaterial.id);
    const [firstRun, secondRun] = await Promise.all([
      repository.createRun(project.id, "same-run-command", "v1", "fake"),
      repository.createRun(project.id, "same-run-command", "v1", "fake"),
    ]);
    expect(secondRun.id).toBe(firstRun.id);
  });

  it("persists positioning separately and supports explicit apply, undo, and invalidation", async () => {
    const project = await repository.createProject("Positioning project");
    await repository.addMaterial(project.id, { name: "brief.txt", mediaType: "text/plain", text: "Teams recover two days." }, "positioning-material");
    const source = (await repository.listSources(project.id))[0]!;
    const chunk = source.chunks[0]!;
    const run = await repository.createRun(project.id, "positioning-run", "v1", "fake");
    const understanding: UnderstandingProposalV1 = { schemaVersion: 1, themes: [{ title: "Speed", summary: "Teams move faster.", claims: [{ statement: "Teams recover two days.", evidenceState: "supported", evidence: [{ sourceId: source.id, chunkId: chunk.id, quote: "Teams recover two days." }], userInputIds: [] }] }], gaps: [], nextQuestion: { question: "Which decision matters?", whyItMatters: "It sets emphasis.", relatedThemeIndexes: [0] } };
    const accepted = await repository.completeRun({ projectId: project.id, runId: run.id, expectedRevision: 0, proposal: understanding });
    await repository.acceptUnderstanding({ projectId: project.id, understandingId: accepted.id, expectedRevision: 1, actorId: "local-user", idempotencyKey: "positioning-accept" });
    const proposal: PositioningProposalV1 = { schemaVersion: 1, understandingVersionId: accepted.id, originalFraming: { title: "Original framing", coreMessage: "Teams move faster." }, directions: ["proof", "decision"].map((id) => ({ id, title: id, coreMessage: `${id} message`, from: "Teams move faster.", to: `${id} framing`, tradeoff: `${id} tradeoff`, excludes: ["unsupported claims"], evidence: [{ sourceId: source.id, chunkId: chunk.id, quote: "Teams recover two days." }], userInputIds: [] })) };
    const created = await repository.createPositioning({ projectId: project.id, understandingId: accepted.id, expectedRevision: 1, proposal, idempotencyKey: "positioning-create" });
    expect((await repository.getCurrentPositioning(project.id))?.id).toBe(created.id);
    expect((await repository.applyPositioning({ projectId: project.id, directionId: "proof", expectedRevision: 1, idempotencyKey: "positioning-apply" })).appliedDirectionId).toBe("proof");
    expect((await repository.undoPositioning({ projectId: project.id, expectedRevision: 1, idempotencyKey: "positioning-undo" })).appliedDirectionId).toBeNull();
    await repository.addMaterial(project.id, { name: "late.txt", mediaType: "text/plain", text: "New evidence." }, "positioning-late-material");
    expect(await repository.getCurrentPositioning(project.id)).toBeUndefined();
  });
});
