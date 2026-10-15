import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  PitchroomError,
  defaultProjectCharacterLimit,
  ingestMaterial,
  understandingProposalV1Schema,
  type AgentEvent,
  type MaterialInput,
  type SourceRecord,
  type ToolRepository,
  type UnderstandingProposalV1,
} from "@pitchroom/domain";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export function createDatabase(url: string) {
  const client = postgres(url, { max: 5 });
  return { client, db: drizzle(client, { schema }) };
}

export class PitchroomRepository implements ToolRepository {
  constructor(readonly db: Database, private readonly maxProjectCharacters = defaultProjectCharacterLimit) {}

  async createProject(name: string): Promise<{ id: string; phase: string; version: number }> {
    const [project] = await this.db.insert(schema.projects).values({ name, slug: `project-${crypto.randomUUID()}` }).returning();
    if (!project) throw new PitchroomError("PERSISTENCE_ERROR", "Project was not created.");
    return project;
  }

  async ensureProject(slug: string, name: string) {
    const existing = await this.db.query.projects.findFirst({ where: eq(schema.projects.slug, slug) });
    if (existing) return existing;
    const [created] = await this.db.insert(schema.projects).values({ slug, name }).onConflictDoNothing({ target: schema.projects.slug }).returning();
    return created ?? this.db.query.projects.findFirst({ where: eq(schema.projects.slug, slug) });
  }

  async getProject(projectId: string) {
    return this.db.query.projects.findFirst({ where: eq(schema.projects.id, projectId) });
  }

  async listVersions(projectId: string) {
    return this.db.select().from(schema.understandingVersions).where(eq(schema.understandingVersions.projectId, projectId)).orderBy(asc(schema.understandingVersions.version));
  }

  async listEvents(projectId: string) {
    return this.db.select({ event: schema.agentEvents }).from(schema.agentEvents)
      .innerJoin(schema.agentRuns, eq(schema.agentEvents.runId, schema.agentRuns.id))
      .where(eq(schema.agentRuns.projectId, projectId))
      .orderBy(asc(schema.agentEvents.createdAt), asc(schema.agentEvents.sequence));
  }

  async addMaterial(projectId: string, input: MaterialInput, idempotencyKey: string) {
    const material = ingestMaterial(projectId, input);
    return this.db.transaction(async (tx) => {
      const receipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, projectId), eq(schema.commandReceipts.idempotencyKey, idempotencyKey)) });
      if (receipt) {
        if (receipt.commandType !== "add_material" || receipt.requestHash !== material.contentHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different material command.");
        const existing = await tx.query.sources.findFirst({ where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.id, receipt.resourceId)) });
        if (!existing) throw new PitchroomError("PERSISTENCE_ERROR", "Material receipt points to a missing source.");
        return existing;
      }
      const [project] = await tx.execute<{ phase: string }>(sql`select phase from projects where id = ${projectId} for update`);
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      const concurrentReceipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, projectId), eq(schema.commandReceipts.idempotencyKey, idempotencyKey)) });
      if (concurrentReceipt) {
        if (concurrentReceipt.commandType !== "add_material" || concurrentReceipt.requestHash !== material.contentHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different material command.");
        const existing = await tx.query.sources.findFirst({ where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.id, concurrentReceipt.resourceId)) });
        if (!existing) throw new PitchroomError("PERSISTENCE_ERROR", "Material receipt points to a missing source.");
        return existing;
      }
      if (project.phase === "reading" || project.phase === "structuring") {
        throw new PitchroomError("INVALID_TRANSITION", `Material cannot be added while the project is ${project.phase}.`);
      }
      const duplicateContent = await tx.query.sources.findFirst({
        where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.contentHash, material.contentHash)),
      });
      if (duplicateContent) {
        await tx.insert(schema.commandReceipts).values({ projectId, idempotencyKey, commandType: "add_material", requestHash: material.contentHash, resourceId: duplicateContent.id });
        return duplicateContent;
      }
      const [usage] = await tx.select({ characters: sql<number>`coalesce(sum(length(${schema.sources.content})), 0)` }).from(schema.sources).where(eq(schema.sources.projectId, projectId));
      if (Number(usage?.characters ?? 0) + material.content.length > this.maxProjectCharacters) {
        throw new PitchroomError("INVALID_INPUT", "Material would exceed the project text limit.", { limit: this.maxProjectCharacters });
      }
      const [source] = await tx.insert(schema.sources).values({
        id: material.sourceId,
        projectId,
        name: material.name,
        mediaType: material.mediaType,
        content: material.content,
        contentHash: material.contentHash,
        idempotencyKey,
      }).returning();
      if (!source) throw new PitchroomError("PERSISTENCE_ERROR", "Source was not created.");
      await tx.insert(schema.sourceChunks).values(material.chunks.map((chunk) => ({
        id: chunk.id,
        sourceId: source.id,
        ordinal: chunk.ordinal,
        startOffset: chunk.startOffset,
        endOffset: chunk.endOffset,
        text: chunk.text,
      })));
      await tx.insert(schema.commandReceipts).values({ projectId, idempotencyKey, commandType: "add_material", requestHash: material.contentHash, resourceId: source.id });
      await tx.update(schema.projects).set({ phase: "materials_ready", currentUnderstandingId: null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
      return source;
    });
  }

  async listSources(projectId: string): Promise<SourceRecord[]> {
    const rows = await this.db.query.sources.findMany({ where: and(eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)), orderBy: asc(schema.sources.createdAt) });
    return Promise.all(rows.map(async (source) => ({
      id: source.id,
      projectId: source.projectId,
      name: source.name,
      mediaType: source.mediaType,
      contentHash: source.contentHash,
      chunks: await this.db.select().from(schema.sourceChunks).where(eq(schema.sourceChunks.sourceId, source.id)).orderBy(asc(schema.sourceChunks.ordinal)),
    })));
  }

  async getSource(projectId: string, sourceId: string): Promise<SourceRecord | undefined> {
    return (await this.listSources(projectId)).find((source) => source.id === sourceId);
  }

  async getChunk(projectId: string, chunkId: string) {
    const [row] = await this.db.select({ chunk: schema.sourceChunks }).from(schema.sourceChunks)
      .innerJoin(schema.sources, eq(schema.sourceChunks.sourceId, schema.sources.id))
      .where(and(eq(schema.sourceChunks.id, chunkId), eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)));
    return row?.chunk;
  }

  async removeMaterial(projectId: string, sourceId: string) {
    return this.db.transaction(async (tx) => {
      const [project] = await tx.execute<{ phase: string }>(sql`select phase from projects where id = ${projectId} for update`);
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (project.phase === "reading" || project.phase === "structuring") throw new PitchroomError("CONFLICT", "Material cannot be removed while the agent is running.");
      const [removed] = await tx.update(schema.sources).set({ deletedAt: new Date() }).where(and(eq(schema.sources.id, sourceId), eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt))).returning({ id: schema.sources.id });
      if (!removed) throw new PitchroomError("NOT_FOUND", "Material was not found in this project.");
      const [remaining] = await tx.select({ count: sql<number>`count(*)` }).from(schema.sources).where(and(eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)));
      await tx.update(schema.projects).set({ currentUnderstandingId: null, phase: Number(remaining?.count ?? 0) ? "materials_ready" : "empty", updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
      return removed;
    });
  }

  async createRun(projectId: string, idempotencyKey: string, promptVersion: string, model: string) {
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.agentRuns.findFirst({ where: and(eq(schema.agentRuns.projectId, projectId), eq(schema.agentRuns.idempotencyKey, idempotencyKey)) });
      if (existing) {
        if (existing.promptVersion !== promptVersion || existing.model !== model) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different run configuration.");
        return existing;
      }
      const [project] = await tx.execute<{ phase: string }>(sql`select phase from projects where id = ${projectId} for update`);
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      const concurrentRun = await tx.query.agentRuns.findFirst({ where: and(eq(schema.agentRuns.projectId, projectId), eq(schema.agentRuns.idempotencyKey, idempotencyKey)) });
      if (concurrentRun) {
        if (concurrentRun.promptVersion !== promptVersion || concurrentRun.model !== model) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different run configuration.");
        return concurrentRun;
      }
      if (project.phase !== "materials_ready" && project.phase !== "cancelled" && project.phase !== "failed") throw new PitchroomError("CONFLICT", "A run can start only when materials are ready or a stopped run is retried.");
      const [run] = await tx.insert(schema.agentRuns).values({ projectId, idempotencyKey, promptVersion, model, status: "running" }).returning();
      if (!run) throw new PitchroomError("PERSISTENCE_ERROR", "Run was not created.");
      await tx.update(schema.projects).set({ phase: "reading", updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
      return run;
    });
  }

  async appendEvent(event: AgentEvent) {
    await this.db.insert(schema.agentEvents).values({ runId: event.runId, sequence: event.sequence, type: event.type, payload: event.payload, createdAt: new Date(event.timestamp) });
  }

  async failRun(input: { projectId: string; runId: string; message: string }) {
    await this.db.transaction(async (tx) => {
      const [run] = await tx.update(schema.agentRuns).set({ status: "failed", finishedAt: new Date() }).where(and(eq(schema.agentRuns.id, input.runId), eq(schema.agentRuns.projectId, input.projectId), eq(schema.agentRuns.status, "running"))).returning({ id: schema.agentRuns.id });
      if (run) await tx.update(schema.projects).set({ phase: "failed", updatedAt: new Date() }).where(and(eq(schema.projects.id, input.projectId), inArray(schema.projects.phase, ["reading", "structuring"])));
    });
  }

  async cancelRun(input: { projectId: string; runId: string; message: string }) {
    await this.db.transaction(async (tx) => {
      const [run] = await tx.update(schema.agentRuns).set({ status: "cancelled", finishedAt: new Date() }).where(and(eq(schema.agentRuns.id, input.runId), eq(schema.agentRuns.projectId, input.projectId), eq(schema.agentRuns.status, "running"))).returning({ id: schema.agentRuns.id });
      if (run) await tx.update(schema.projects).set({ phase: "cancelled", updatedAt: new Date() }).where(and(eq(schema.projects.id, input.projectId), inArray(schema.projects.phase, ["reading", "structuring"])));
    });
  }

  async completeRun(input: { projectId: string; runId: string; expectedRevision: number; proposal: UnderstandingProposalV1 }) {
    return this.db.transaction(async (tx) => {
      const [locked] = await tx.execute<{ version: number; phase: string }>(sql`select version, phase from projects where id = ${input.projectId} for update`);
      if (!locked) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (locked.version !== input.expectedRevision) throw new PitchroomError("CONFLICT", "Project revision is stale.");
      if (locked.phase !== "reading" && locked.phase !== "structuring") throw new PitchroomError("CONFLICT", "The project is no longer owned by this run.");
      const nextVersion = locked.version + 1;
      const run = await tx.query.agentRuns.findFirst({ where: and(eq(schema.agentRuns.id, input.runId), eq(schema.agentRuns.projectId, input.projectId)) });
      if (!run || run.status !== "running") throw new PitchroomError("CONFLICT", "The active run does not belong to this project.");
      const [understanding] = await tx.insert(schema.understandingVersions).values({ projectId: input.projectId, runId: input.runId, createdBy: "agent", version: nextVersion, status: "review_required", proposal: input.proposal }).returning();
      if (!understanding) throw new PitchroomError("PERSISTENCE_ERROR", "Understanding was not created.");
      await tx.update(schema.projects).set({ version: nextVersion, currentUnderstandingId: understanding.id, phase: "review_required", updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      await tx.update(schema.agentRuns).set({ status: "completed", finishedAt: new Date() }).where(eq(schema.agentRuns.id, input.runId));
      return understanding;
    });
  }

  async recordUserInput(input: { projectId: string; kind: "answer" | "correction" | "keep_unknown"; text: string; actorId: string; targetVersion: number; idempotencyKey: string }) {
    const project = await this.getProject(input.projectId);
    if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
    if (project.phase !== "review_required" || project.version !== input.targetVersion) throw new PitchroomError("CONFLICT", "User input targets a stale understanding version.");
    const existing = await this.db.query.userInputs.findFirst({ where: and(eq(schema.userInputs.projectId, input.projectId), eq(schema.userInputs.idempotencyKey, input.idempotencyKey)) });
    if (existing) return existing;
    const [created] = await this.db.insert(schema.userInputs).values(input).returning();
    if (!created) throw new PitchroomError("PERSISTENCE_ERROR", "User input was not recorded.");
    return created;
  }

  async createUserVersion(input: {
    projectId: string;
    expectedRevision: number;
    kind: "answer" | "correction" | "keep_unknown";
    text: string;
    actorId: string;
    idempotencyKey: string;
    proposal: UnderstandingProposalV1;
  }) {
    return this.db.transaction(async (tx) => {
      const existingInput = await tx.query.userInputs.findFirst({ where: and(eq(schema.userInputs.projectId, input.projectId), eq(schema.userInputs.idempotencyKey, input.idempotencyKey)) });
      if (existingInput) {
        if (existingInput.kind !== input.kind || existingInput.text !== input.text || existingInput.actorId !== input.actorId || existingInput.targetVersion !== input.expectedRevision) {
          throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different user input.");
        }
        const existingVersion = await tx.query.understandingVersions.findFirst({ where: eq(schema.understandingVersions.userInputId, existingInput.id) });
        if (!existingVersion) throw new PitchroomError("PERSISTENCE_ERROR", "Idempotent user input has no version.");
        return existingVersion;
      }
      const [locked] = await tx.execute<{ version: number; phase: string }>(sql`select version, phase from projects where id = ${input.projectId} for update`);
      if (!locked) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (locked.phase !== "review_required" || locked.version !== input.expectedRevision) throw new PitchroomError("CONFLICT", "User input targets a stale understanding version.");
      const [userInput] = await tx.insert(schema.userInputs).values({ projectId: input.projectId, kind: input.kind, text: input.text, actorId: input.actorId, targetVersion: input.expectedRevision, idempotencyKey: input.idempotencyKey }).returning();
      if (!userInput) throw new PitchroomError("PERSISTENCE_ERROR", "User input was not recorded.");
      const attributedProposal = structuredClone(input.proposal);
      for (const theme of attributedProposal.themes) {
        for (const claim of theme.claims) {
          if (claim.evidenceState === "user_asserted") claim.userInputIds = [userInput.id];
        }
      }
      const validatedProposal = understandingProposalV1Schema.parse(attributedProposal);
      const nextVersion = locked.version + 1;
      const [version] = await tx.insert(schema.understandingVersions).values({ projectId: input.projectId, runId: null, userInputId: userInput.id, createdBy: "user", version: nextVersion, status: "review_required", proposal: validatedProposal }).returning();
      if (!version) throw new PitchroomError("PERSISTENCE_ERROR", "User understanding version was not created.");
      await tx.update(schema.projects).set({ version: nextVersion, currentUnderstandingId: version.id, updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      return version;
    });
  }

  async acceptUnderstanding(input: { projectId: string; understandingId: string; expectedRevision: number; actorId: string; idempotencyKey: string }) {
    return this.db.transaction(async (tx) => {
      const project = await tx.query.projects.findFirst({ where: eq(schema.projects.id, input.projectId) });
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (project.version !== input.expectedRevision || project.currentUnderstandingId !== input.understandingId || project.phase !== "review_required") {
        throw new PitchroomError("CONFLICT", "Only the current reviewed understanding can be accepted.");
      }
      const existing = await tx.query.approvals.findFirst({ where: and(eq(schema.approvals.projectId, input.projectId), eq(schema.approvals.idempotencyKey, input.idempotencyKey)) });
      if (existing) {
        if (existing.understandingId !== input.understandingId || existing.actorId !== input.actorId) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different approval.");
        return existing;
      }
      const [approval] = await tx.insert(schema.approvals).values({ projectId: input.projectId, understandingId: input.understandingId, decision: "accepted", actorId: input.actorId, idempotencyKey: input.idempotencyKey }).returning();
      await tx.update(schema.projects).set({ phase: "accepted", updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      return approval;
    });
  }
}
