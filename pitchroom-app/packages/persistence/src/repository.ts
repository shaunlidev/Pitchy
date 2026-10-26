import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  PitchroomError,
  defaultProjectCharacterLimit,
  deckProposalV1Schema,
  deckProposalSchema,
  ingestMaterial,
  positioningProposalV1Schema,
  understandingProposalV1Schema,
  type AgentEvent,
  type DeckProposalV1,
  type MaterialInput,
  type PositioningProposalV1,
  type SourceRecord,
  type ToolRepository,
  type UnderstandingProposalV1,
} from "@pitchroom/domain";
import * as schema from "./schema";

export type Database = PostgresJsDatabase<typeof schema>;

export function bindDatabase(client: ReturnType<typeof postgres>) {
  return { client, db: drizzle(client, { schema }) };
}

export function createDatabase(url: string) {
  const client = postgres(url, { max: 5 });
  return bindDatabase(client);
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
        if (existing.deletedAt) throw new PitchroomError("CONFLICT", "This material was removed after its original save. Re-add it explicitly with a new command.");
        return existing;
      }
      const [project] = await tx.execute<{ phase: string }>(sql`select phase from projects where id = ${projectId} for update`);
      if (!project) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      const concurrentReceipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, projectId), eq(schema.commandReceipts.idempotencyKey, idempotencyKey)) });
      if (concurrentReceipt) {
        if (concurrentReceipt.commandType !== "add_material" || concurrentReceipt.requestHash !== material.contentHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different material command.");
        const existing = await tx.query.sources.findFirst({ where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.id, concurrentReceipt.resourceId)) });
        if (!existing) throw new PitchroomError("PERSISTENCE_ERROR", "Material receipt points to a missing source.");
        if (existing.deletedAt) throw new PitchroomError("CONFLICT", "This material was removed after its original save. Re-add it explicitly with a new command.");
        return existing;
      }
      if (project.phase === "reading" || project.phase === "structuring") {
        throw new PitchroomError("INVALID_TRANSITION", `Material cannot be added while the project is ${project.phase}.`);
      }
      const duplicateContent = await tx.query.sources.findFirst({
        where: and(eq(schema.sources.projectId, projectId), eq(schema.sources.contentHash, material.contentHash), eq(schema.sources.kind, "file")),
      });
      if (duplicateContent) {
        if (duplicateContent.deletedAt) {
          await tx.update(schema.sources).set({ deletedAt: null }).where(and(eq(schema.sources.id, duplicateContent.id), eq(schema.sources.projectId, projectId)));
          await tx.update(schema.projects).set({ phase: "materials_ready", currentUnderstandingId: null, currentPositioningId: null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
        }
        await tx.insert(schema.commandReceipts).values({ projectId, idempotencyKey, commandType: "add_material", requestHash: material.contentHash, resourceId: duplicateContent.id });
        return { ...duplicateContent, deletedAt: null };
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
      await tx.update(schema.projects).set({ phase: "materials_ready", currentUnderstandingId: null, currentPositioningId: null, updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
      return source;
    });
  }

  async listSources(projectId: string): Promise<SourceRecord[]> {
    const rows = await this.db.query.sources.findMany({ where: and(eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)), orderBy: asc(schema.sources.createdAt) });
    return Promise.all(rows.map(async (source) => ({
      id: source.id,
      projectId: source.projectId,
      name: source.name,
      kind: source.kind,
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
      const [removed] = await tx.update(schema.sources).set({ deletedAt: new Date() }).where(and(eq(schema.sources.id, sourceId), eq(schema.sources.projectId, projectId), eq(schema.sources.kind, "file"), isNull(schema.sources.deletedAt))).returning({ id: schema.sources.id });
      if (!removed) throw new PitchroomError("NOT_FOUND", "Material was not found in this project.");
      const [remaining] = await tx.select({ count: sql<number>`count(*)` }).from(schema.sources).where(and(eq(schema.sources.projectId, projectId), isNull(schema.sources.deletedAt)));
      await tx.update(schema.projects).set({ currentUnderstandingId: null, currentPositioningId: null, phase: Number(remaining?.count ?? 0) ? "materials_ready" : "empty", updatedAt: new Date() }).where(eq(schema.projects.id, projectId));
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
      const pending = await tx.execute(sql`select id from clarification_tasks where project_id = ${input.projectId} and payload->>'status' in ('queued','running','proposal_ready','no_change','failed') limit 1`);
      if (pending.length) throw new PitchroomError("CONFLICT", "Resolve the current clarification before changing the version.");
      if (locked.phase !== "review_required" || locked.version !== input.expectedRevision) throw new PitchroomError("CONFLICT", "User input targets a stale understanding version.");
      const [userInput] = await tx.insert(schema.userInputs).values({ projectId: input.projectId, kind: input.kind, text: input.text, actorId: input.actorId, targetVersion: input.expectedRevision, idempotencyKey: input.idempotencyKey }).returning();
      if (!userInput) throw new PitchroomError("PERSISTENCE_ERROR", "User input was not recorded.");
      const attributedProposal = structuredClone(input.proposal);
      for (const theme of attributedProposal.themes) {
        for (const claim of theme.claims) {
          if (claim.evidenceState === "user_asserted" && claim.userInputIds.some(id => id === "assigned-transactionally" || id === "pending-at-persistence-boundary")) claim.userInputIds = [userInput.id];
          if (claim.supersededBy?.inputId === "assigned-transactionally") { claim.supersededBy.inputId = userInput.id; claim.supersededBy.taskId = `manual:${userInput.id}`; }
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
      await tx.execute(sql`select id from projects where id = ${input.projectId} for update`);
      const pending = await tx.execute(sql`select id from clarification_tasks where project_id = ${input.projectId} and payload->>'status' in ('queued','running','proposal_ready','no_change','failed') limit 1`);
      if (pending.length) throw new PitchroomError("CONFLICT", "Resolve the current clarification before accepting.");
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

  async getCurrentPositioning(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project?.currentPositioningId) return undefined;
    return this.db.query.positioningVersions.findFirst({ where: and(eq(schema.positioningVersions.projectId, projectId), eq(schema.positioningVersions.id, project.currentPositioningId)) });
  }

  async listPositioningVersions(projectId: string) {
    return this.db.query.positioningVersions.findMany({
      where: eq(schema.positioningVersions.projectId, projectId),
      orderBy: asc(schema.positioningVersions.version),
    });
  }

  async createPositioning(input: { projectId: string; understandingId: string; expectedRevision: number; proposal: PositioningProposalV1; idempotencyKey: string }) {
    const proposal = positioningProposalV1Schema.parse(input.proposal);
    const requestHash = JSON.stringify({ understandingId: input.understandingId, expectedRevision: input.expectedRevision, proposal });
    return this.db.transaction(async (tx) => {
      const existing = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, input.projectId), eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)) });
      if (existing) {
        if (existing.commandType !== "generate_positioning" || existing.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different positioning command.");
        const record = await tx.query.positioningVersions.findFirst({ where: eq(schema.positioningVersions.id, existing.resourceId) });
        if (!record) throw new PitchroomError("PERSISTENCE_ERROR", "Positioning receipt points to a missing version.");
        return record;
      }
      const [locked] = await tx.execute<{ version: number; phase: string; current_understanding_id: string | null }>(sql`select version, phase, current_understanding_id from projects where id = ${input.projectId} for update`);
      if (!locked) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (locked.phase !== "accepted" || locked.version !== input.expectedRevision || locked.current_understanding_id !== input.understandingId) throw new PitchroomError("CONFLICT", "Positioning must use the current accepted understanding.");
      const [latest] = await tx.select({ version: sql<number>`coalesce(max(${schema.positioningVersions.version}), 0)` }).from(schema.positioningVersions).where(eq(schema.positioningVersions.projectId, input.projectId));
      const [created] = await tx.insert(schema.positioningVersions).values({ projectId: input.projectId, understandingId: input.understandingId, version: Number(latest?.version ?? 0) + 1, proposal }).returning();
      if (!created) throw new PitchroomError("PERSISTENCE_ERROR", "Positioning version was not created.");
      await tx.update(schema.projects).set({ currentPositioningId: created.id, updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      await tx.insert(schema.commandReceipts).values({ projectId: input.projectId, idempotencyKey: input.idempotencyKey, commandType: "generate_positioning", requestHash, resourceId: created.id });
      return created;
    });
  }

  async applyPositioning(input: { projectId: string; directionId: string; expectedRevision: number; idempotencyKey: string }) {
    return this.changePositioning({ ...input, commandType: "apply_positioning" });
  }

  async undoPositioning(input: { projectId: string; expectedRevision: number; idempotencyKey: string }) {
    return this.changePositioning({ ...input, directionId: undefined, commandType: "undo_positioning" });
  }

  async adjustPositioning(input: { projectId: string; directionId: string; mode: "headline" | "judgment_note"; text: string; expectedRevision: number; idempotencyKey: string }) {
    const requestHash = JSON.stringify({ directionId: input.directionId, mode: input.mode, text: input.text, expectedRevision: input.expectedRevision });
    return this.db.transaction(async (tx) => {
      const receipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, input.projectId), eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)) });
      if (receipt) {
        if (receipt.commandType !== "adjust_positioning" || receipt.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different positioning adjustment.");
        return tx.query.positioningVersions.findFirst({ where: eq(schema.positioningVersions.id, receipt.resourceId) });
      }
      const [locked] = await tx.execute<{ version: number; phase: string; current_positioning_id: string | null }>(sql`select version, phase, current_positioning_id from projects where id = ${input.projectId} for update`);
      if (!locked || locked.phase !== "accepted" || locked.version !== input.expectedRevision || !locked.current_positioning_id) throw new PitchroomError("CONFLICT", "This positioning view is stale or not ready.");
      const current = await tx.query.positioningVersions.findFirst({ where: eq(schema.positioningVersions.id, locked.current_positioning_id) });
      if (!current) throw new PitchroomError("NOT_FOUND", "The current positioning version was not found.");
      const proposal = structuredClone(current.proposal); const direction = proposal.directions.find((candidate) => candidate.id === input.directionId);
      if (!direction) throw new PitchroomError("INVALID_INPUT", "Only a proposed direction can be adjusted.");
      const [userInput] = await tx.insert(schema.userInputs).values({ projectId: input.projectId, kind: "correction", text: input.text.trim(), actorId: "synthetic-local-user", targetVersion: input.expectedRevision, idempotencyKey: input.idempotencyKey }).returning();
      if (!userInput) throw new PitchroomError("PERSISTENCE_ERROR", "Positioning adjustment was not recorded.");
      if (input.mode === "headline") direction.coreMessage = input.text.trim(); else direction.judgmentNote = input.text.trim();
      direction.userInputIds = [...direction.userInputIds, userInput.id];
      const validated = positioningProposalV1Schema.parse(proposal);
      const [created] = await tx.insert(schema.positioningVersions).values({ projectId: input.projectId, understandingId: current.understandingId, version: current.version + 1, proposal: validated }).returning();
      if (!created) throw new PitchroomError("PERSISTENCE_ERROR", "Adjusted positioning version was not created.");
      await tx.update(schema.projects).set({ currentPositioningId: created.id, updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      await tx.insert(schema.commandReceipts).values({ projectId: input.projectId, idempotencyKey: input.idempotencyKey, commandType: "adjust_positioning", requestHash, resourceId: created.id });
      return created;
    });
  }

  private async changePositioning(input: { projectId: string; directionId?: string; expectedRevision: number; idempotencyKey: string; commandType: "apply_positioning" | "undo_positioning" }) {
    const requestHash = JSON.stringify({ directionId: input.directionId ?? null, expectedRevision: input.expectedRevision });
    return this.db.transaction(async (tx) => {
      const receipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, input.projectId), eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)) });
      if (receipt) {
        if (receipt.commandType !== input.commandType || receipt.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different positioning command.");
        const record = await tx.query.positioningVersions.findFirst({ where: eq(schema.positioningVersions.id, receipt.resourceId) });
        if (!record) throw new PitchroomError("PERSISTENCE_ERROR", "Positioning receipt points to a missing version.");
        return record;
      }
      const [locked] = await tx.execute<{ version: number; phase: string; current_positioning_id: string | null }>(sql`select version, phase, current_positioning_id from projects where id = ${input.projectId} for update`);
      if (!locked) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (locked.phase !== "accepted" || locked.version !== input.expectedRevision || !locked.current_positioning_id) throw new PitchroomError("CONFLICT", "This positioning view is stale or not ready.");
      const current = await tx.query.positioningVersions.findFirst({ where: eq(schema.positioningVersions.id, locked.current_positioning_id) });
      if (!current) throw new PitchroomError("PERSISTENCE_ERROR", "The current positioning version is missing.");
      let appliedDirectionId: string | null;
      let previousAppliedDirectionId: string | null;
      if (input.commandType === "undo_positioning") {
        if (!current.appliedDirectionId) throw new PitchroomError("CONFLICT", "There is no current positioning change to undo.");
        appliedDirectionId = current.previousAppliedDirectionId ?? null;
        previousAppliedDirectionId = null;
      } else {
        if (!input.directionId || (input.directionId !== "original" && !current.proposal.directions.some((direction) => direction.id === input.directionId))) throw new PitchroomError("INVALID_INPUT", "The selected direction does not exist.");
        previousAppliedDirectionId = current.appliedDirectionId ?? null;
        appliedDirectionId = input.directionId;
      }
      const [updated] = await tx.update(schema.positioningVersions).set({ appliedDirectionId, previousAppliedDirectionId, updatedAt: new Date() }).where(eq(schema.positioningVersions.id, current.id)).returning();
      if (!updated) throw new PitchroomError("PERSISTENCE_ERROR", "Positioning change was not saved.");
      await tx.insert(schema.commandReceipts).values({ projectId: input.projectId, idempotencyKey: input.idempotencyKey, commandType: input.commandType, requestHash, resourceId: current.id });
      return updated;
    });
  }

  async startWorkflowRun(input: { projectId: string; kind: "positioning" | "deck" | "story"; targetRevision: number; model: string; idempotencyKey: string }) {
    const [created] = await this.db.insert(schema.workflowRuns).values({ ...input, status: "running", events: [{ type: "run_started", detail: `${input.kind} generation started`, at: new Date().toISOString() }] }).onConflictDoNothing().returning();
    const run = created ?? await this.db.query.workflowRuns.findFirst({ where: and(eq(schema.workflowRuns.projectId, input.projectId), eq(schema.workflowRuns.idempotencyKey, input.idempotencyKey)) });
    if (!run) throw new PitchroomError("PERSISTENCE_ERROR", "Workflow run was not created or recovered.");
    if (run.kind !== input.kind || run.targetRevision !== input.targetRevision || run.model !== input.model) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different workflow run.");
    return { run, created: Boolean(created) };
  }

  async getCommandReceipt(projectId: string, idempotencyKey: string) {
    return this.db.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, projectId), eq(schema.commandReceipts.idempotencyKey, idempotencyKey)) });
  }

  async appendWorkflowEvent(runId: string, type: string, detail: string) {
    const run = await this.db.query.workflowRuns.findFirst({ where: eq(schema.workflowRuns.id, runId) });
    if (!run) throw new PitchroomError("NOT_FOUND", "Workflow run was not found.");
    const events = [...run.events, { type, detail, at: new Date().toISOString() }];
    await this.db.update(schema.workflowRuns).set({ events }).where(eq(schema.workflowRuns.id, runId));
  }

  async completeWorkflowRun(runId: string, resultId: string) {
    await this.appendWorkflowEvent(runId, "run_completed", "Validated result persisted");
    await this.db.update(schema.workflowRuns).set({ status: "completed", resultId, finishedAt: new Date() }).where(eq(schema.workflowRuns.id, runId));
  }

  async failWorkflowRun(runId: string, error: unknown) {
    const code = error instanceof PitchroomError ? error.code : "WORKFLOW_FAILED";
    const message = error instanceof Error ? error.message : "Workflow failed.";
    await this.appendWorkflowEvent(runId, "run_failed", message);
    await this.db.update(schema.workflowRuns).set({ status: "failed", failureCode: code, failureMessage: message, finishedAt: new Date() }).where(eq(schema.workflowRuns.id, runId));
  }

  async listWorkflowRuns(projectId: string) {
    return this.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.projectId, projectId)).orderBy(asc(schema.workflowRuns.startedAt));
  }

  async listDeckVersions(projectId: string) {
    return this.db.select().from(schema.deckVersions).where(eq(schema.deckVersions.projectId, projectId)).orderBy(asc(schema.deckVersions.version));
  }

  async getCurrentDeck(projectId: string) {
    const project = await this.getProject(projectId);
    if (!project?.currentDeckId) return undefined;
    return this.db.query.deckVersions.findFirst({ where: and(eq(schema.deckVersions.projectId, projectId), eq(schema.deckVersions.id, project.currentDeckId)) });
  }

  async createDeck(input: { projectId: string; understandingId: string; positioningId: string; appliedDirectionId: string; expectedRevision: number; proposal: DeckProposalV1; idempotencyKey: string }) {
    const proposal = deckProposalV1Schema.parse(input.proposal);
    const requestHash = JSON.stringify({ understandingId: input.understandingId, positioningId: input.positioningId, appliedDirectionId: input.appliedDirectionId, expectedRevision: input.expectedRevision, proposal });
    return this.db.transaction(async (tx) => {
      const receipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, input.projectId), eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)) });
      if (receipt) {
        if (receipt.commandType !== "generate_deck" || receipt.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different deck command.");
        const existing = await tx.query.deckVersions.findFirst({ where: eq(schema.deckVersions.id, receipt.resourceId) });
        if (!existing) throw new PitchroomError("PERSISTENCE_ERROR", "Deck receipt points to a missing version.");
        return existing;
      }
      const [locked] = await tx.execute<{ version: number; phase: string; current_understanding_id: string | null; current_positioning_id: string | null }>(sql`select version, phase, current_understanding_id, current_positioning_id from projects where id = ${input.projectId} for update`);
      if (!locked) throw new PitchroomError("NOT_FOUND", "Project was not found.");
      if (locked.phase !== "accepted" || locked.version !== input.expectedRevision || locked.current_understanding_id !== input.understandingId || locked.current_positioning_id !== input.positioningId) throw new PitchroomError("CONFLICT", "Deck inputs are stale.");
      const positioning = await tx.query.positioningVersions.findFirst({ where: eq(schema.positioningVersions.id, input.positioningId) });
      if (!positioning || positioning.appliedDirectionId !== input.appliedDirectionId) throw new PitchroomError("CONFLICT", "Apply a current positioning direction before creating a deck.");
      const [latest] = await tx.select({ version: sql<number>`coalesce(max(${schema.deckVersions.version}), 0)` }).from(schema.deckVersions).where(eq(schema.deckVersions.projectId, input.projectId));
      const [created] = await tx.insert(schema.deckVersions).values({ projectId: input.projectId, understandingId: input.understandingId, positioningId: input.positioningId, appliedDirectionId: input.appliedDirectionId, version: Number(latest?.version ?? 0) + 1, createdBy: "agent", proposal }).returning();
      if (!created) throw new PitchroomError("PERSISTENCE_ERROR", "Deck version was not created.");
      await tx.update(schema.projects).set({ currentDeckId: created.id, updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      await tx.insert(schema.commandReceipts).values({ projectId: input.projectId, idempotencyKey: input.idempotencyKey, commandType: "generate_deck", requestHash, resourceId: created.id });
      return created;
    });
  }

  async editDeckPage(input: { projectId: string; deckId: string; expectedDeckVersion: number; pageId: string; title: string; body: string; idempotencyKey: string }) {
    const requestHash = JSON.stringify({ deckId: input.deckId, expectedDeckVersion: input.expectedDeckVersion, pageId: input.pageId, title: input.title, body: input.body });
    return this.db.transaction(async (tx) => {
      const receipt = await tx.query.commandReceipts.findFirst({ where: and(eq(schema.commandReceipts.projectId, input.projectId), eq(schema.commandReceipts.idempotencyKey, input.idempotencyKey)) });
      if (receipt) {
        if (receipt.commandType !== "edit_deck_page" || receipt.requestHash !== requestHash) throw new PitchroomError("CONFLICT", "Idempotency key was already used for a different deck edit.");
        return tx.query.deckVersions.findFirst({ where: eq(schema.deckVersions.id, receipt.resourceId) });
      }
      const [locked] = await tx.execute<{ current_deck_id: string | null }>(sql`select current_deck_id from projects where id = ${input.projectId} for update`);
      if (!locked?.current_deck_id || locked.current_deck_id !== input.deckId) throw new PitchroomError("CONFLICT", "Only the current deck can be edited.");
      const current = await tx.query.deckVersions.findFirst({ where: eq(schema.deckVersions.id, input.deckId) });
      if (!current || current.version !== input.expectedDeckVersion) throw new PitchroomError("CONFLICT", "This deck draft is stale.");
      const proposal = structuredClone(current.proposal);
      const page = proposal.pages.find((candidate) => candidate.id === input.pageId);
      if (!page) throw new PitchroomError("INVALID_INPUT", "The selected deck page does not exist.");
      page.title = input.title; page.body = input.body;
      if ("wording" in page) page.wording = "user_edited_unreviewed";
      const validated = deckProposalSchema.parse(proposal);
      const [created] = await tx.insert(schema.deckVersions).values({ projectId: input.projectId, understandingId: current.understandingId, storyId: current.storyId, positioningId: current.positioningId, appliedDirectionId: current.appliedDirectionId, version: current.version + 1, createdBy: "user", proposal: validated }).returning();
      if (!created) throw new PitchroomError("PERSISTENCE_ERROR", "Edited deck version was not created.");
      await tx.update(schema.projects).set({ currentDeckId: created.id, updatedAt: new Date() }).where(eq(schema.projects.id, input.projectId));
      await tx.insert(schema.commandReceipts).values({ projectId: input.projectId, idempotencyKey: input.idempotencyKey, commandType: "edit_deck_page", requestHash, resourceId: created.id });
      return created;
    });
  }
}
